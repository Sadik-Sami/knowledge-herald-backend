require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SK);
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3b45u.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

//NOTE: MIDDLEWARES
app.use(
	cors({
		origin: ['http://localhost:5173', 'http://localhost:5174'],
	})
);
app.use(express.json());

// NOTE: Database Client
const client = new MongoClient(uri, {
	serverApi: {
		version: ServerApiVersion.v1,
		strict: true,
		deprecationErrors: true,
	},
});

// NOTE: Database Collections
const usersCollection = client.db('heraldDB').collection('users');
const paymentsCollection = client.db('heraldDB').collection('payments');
const publishersCollection = client.db('heraldDB').collection('publishers');
const articlesCollection = client.db('heraldDB').collection('articles');
const plansCollection = client.db('heraldDB').collection('plans');
const commentsCollection = client.db('heraldDB').collection('comments');

//NOTE: CUSTOM MIDDLEWARES
//? Verify user
const verifyUser = (req, res, next) => {
	const authHeader = req.headers.authorization;
	if (!authHeader) {
		return res.status(401).send({ success: false, message: 'Unauthorized Access' });
	}
	const token = authHeader.split(' ')[1];
	jwt.verify(token, process.env.JWT_SECRET, (error, decoded) => {
		if (error) {
			return res.status(401).send({ success: false, message: 'Unauthorized Access' });
		}
		req.decoded = decoded;
		next();
	});
};

//?  Verify Admin
const verifyAdmin = async (req, res, next) => {
	const email = req.decoded.email;
	const query = { email: email };
	const user = await usersCollection.findOne(query);

	const isAdmin = user?.role === 'admin';
	if (!isAdmin) {
		return res.status(403).send({ success: false, message: 'Forbidden Access' });
	}
	next();
};

//? Verify Subscription
const verifySubscription = async (req, res, next) => {
	try {
		const email = req.decoded.email;
		const user = await usersCollection.findOne({ email });

		if (!user?.hasSubscription) {
			return res.status(403).json({
				success: false,
				message: 'This content requires an active subscription',
			});
		}

		// Check if subscription has expired
		if (user.subscriptionEnd && new Date(user.subscriptionEnd) < new Date()) {
			await usersCollection.updateOne({ email }, { $set: { hasSubscription: false }, $unset: { subscriptionEnd: '' } });

			return res.status(403).json({
				success: false,
				message: 'Your subscription has expired',
			});
		}

		next();
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error verifying subscription',
		});
	}
};

// NOTE: AUTH AND JWT
//? JWT auth and token
app.post('/auth/login', async (req, res) => {
	const user = req.body;
	try {
		const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });
		res.send({ success: true, uToken: token });
	} catch (error) {
		console.log(error);
	}
});

//? Check subscription status
app.get('/users/subscription/:email', verifyUser, async (req, res) => {
	const email = req.params.email;
	if (email !== req.decoded.email) {
		return res.status(403).json({ success: false, message: 'Unauthorized access' });
	}

	try {
		const user = await usersCollection.findOne({ email });
		if (!user) {
			return res.json({ success: true, hasSubscription: false });
		}

		const hasActiveSubscription =
			user.hasSubscription && user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date();

		if (!hasActiveSubscription && user.hasSubscription) {
			// Update user if subscription has expired
			await usersCollection.updateOne({ email }, { $set: { hasSubscription: false, subscriptionEnd: null } });
		}

		res.json({
			success: true,
			hasSubscription: hasActiveSubscription,
			subscriptionEnd: hasActiveSubscription ? user.subscriptionEnd : null,
		});
	} catch (error) {
		res.status(500).json({ success: false, message: 'Server Error' });
	}
});

//? Add firebase user to database
app.post('/users', async (req, res) => {
	const user = req.body;
	try {
		await usersCollection.createIndex({ email: 1 }, { unique: true });
		const result = await usersCollection.insertOne({
			...user,
			created_at: new Date(),
			hasSubscription: false,
			subscriptionEnd: null,
			role: 'user',
		});

		if (!result.insertedId) {
			return res.json({ success: false, message: 'Failed to add user' });
		}
		res.json({ success: true, message: 'User Added Successfully' });
	} catch (error) {
		if (error.code === 11000) {
			res.json({ success: false, message: 'Email already exists' });
		} else {
			res.status(500).json({ success: false, message: 'Server Error' });
		}
	}
});

//? Update user profile with transaction to update related articles
app.patch('/users/profile', verifyUser, async (req, res) => {
	// Start a session for the transaction
	const session = client.startSession();
	try {
		// Start transaction
		await session.withTransaction(async () => {
			const { name, photo } = req.body;
			const email = req.decoded.email;
			// Update user profile
			const userUpdateResult = await usersCollection.updateOne(
				{ email },
				{
					$set: {
						name,
						photo,
						updated_at: new Date(),
					},
				},
				{ session }
			);

			if (userUpdateResult.modifiedCount === 0) {
				throw new Error('Failed to update user profile');
			}

			// Update all articles by this author
			const articlesUpdateResult = await articlesCollection.updateMany(
				{ authorEmail: email },
				{
					$set: {
						authorName: name,
						authorImage: photo,
					},
				},
				{ session }
			);

			// Update all comments by this user
			await commentsCollection.updateMany(
				{ userEmail: email },
				{
					$set: {
						userName: name,
						userImage: photo,
					},
				},
				{ session }
			);
			// Return the update counts
			return {
				userUpdated: userUpdateResult.modifiedCount,
				articlesUpdated: articlesUpdateResult.modifiedCount,
			};
		});
		res.json({
			success: true,
			message: 'Profile updated successfully',
		});
	} catch (error) {
		console.error('Profile Update Error:', error);
		res.status(500).json({
			success: false,
			message: error.message || 'Error updating profile',
		});
	} finally {
		// End the session
		await session.endSession();
	}
});

// NOTE: ADMIN RELATED API
//? is Admin
app.get('/users/admin/:email', verifyUser, async (req, res) => {
	const email = req.params.email;
	if (email !== req.decoded.email) {
		return res.status(403).send({ success: false, message: 'Unauthorized access' });
	}
	const user = await usersCollection.findOne({ email: email });
	let isAdmin = false;
	if (user) {
		isAdmin = user?.role === 'admin';
	}
	res.send({ success: true, isAdmin });
});

//? Make admin
app.patch('/make-admin/:id', verifyUser, verifyAdmin, async (req, res) => {
	try {
		const result = await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: 'admin' } });

		if (result.modifiedCount === 0) {
			return res.status(404).json({
				success: false,
				message: 'User not found',
			});
		}

		res.json({
			success: true,
			message: 'User has been made admin successfully',
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error updating user role',
		});
	}
});

//? Get All Users
app.get('/users', verifyUser, verifyAdmin, async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 10;
		const skip = (page - 1) * limit;

		const [users, total] = await Promise.all([
			usersCollection.find().skip(skip).limit(limit).toArray(),
			usersCollection.countDocuments(),
		]);

		res.json({
			success: true,
			data: users,
			total,
			page,
			limit,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching users',
		});
	}
});

//? Make Article Premium
app.patch('/articles/:id/premium', verifyUser, verifyAdmin, async (req, res) => {
	try {
		const result = await articlesCollection.updateOne(
			{ _id: new ObjectId(req.params.id) },
			{ $set: { isPremium: true, updatedAt: new Date() } }
		);

		if (result.modifiedCount === 0) {
			return res.status(404).json({
				success: false,
				message: 'Article not found',
			});
		}

		res.json({
			success: true,
			message: 'Article marked as premium successfully',
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error updating article premium status',
		});
	}
});

//? Change Article Status
app.patch('/admin/articles/:id', verifyUser, verifyAdmin, async (req, res) => {
	try {
		const { status, declined_reason } = req.body;
		const updateData = { status, updatedAt: new Date() };

		if (declined_reason) {
			updateData.declined_reason = declined_reason;
		}

		const result = await articlesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });

		if (result.modifiedCount === 0) {
			return res.status(404).json({
				success: false,
				message: 'Article not found',
			});
		}

		res.json({
			success: true,
			message: `Article ${status} successfully`,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error updating article status',
		});
	}
});

// NOTE: ARTICLE RELATED API
//? Get all articles
app.get('/articles', async (req, res) => {
	try {
		const page = parseInt(req.query.page) || 1;
		const limit = parseInt(req.query.limit) || 10;
		const skip = (page - 1) * limit;

		const search = req.query.search || '';
		const publisher = req.query.publisher || '';
		const tags = req.query.tags ? req.query.tags.split(',') : [];
		const statuses = Array.isArray(req.query.status) ? req.query.status : [req.query.status].filter(Boolean);

		const matchStage = {};

		// Add status filter
		if (statuses.length > 0) {
			matchStage.status = { $in: statuses };
		}

		if (search) {
			matchStage.$or = [{ title: { $regex: search, $options: 'i' } }, { content: { $regex: search, $options: 'i' } }];
		}

		if (publisher) {
			matchStage.publisher = new ObjectId(publisher);
		}

		if (tags.length > 0) {
			matchStage.tags = { $elemMatch: { value: { $in: tags } } };
		}

		const [articles, total] = await Promise.all([
			articlesCollection
				.aggregate([
					{
						$addFields: {
							publisher: {
								$cond: {
									if: { $eq: [{ $type: '$publisher' }, 'string'] },
									then: { $toObjectId: '$publisher' },
									else: '$publisher',
								},
							},
						},
					},
					{
						$match: matchStage,
					},
					{
						$lookup: {
							from: 'publishers',
							localField: 'publisher',
							foreignField: '_id',
							as: 'author',
						},
					},
					{
						$unwind: '$author',
					},
					{
						$sort: { createdAt: -1 }, // Add sorting by creation date
					},
					{
						$skip: skip,
					},
					{
						$limit: limit,
					},
				])
				.toArray(),
			articlesCollection.countDocuments(matchStage),
		]);

		res.json({
			success: true,
			data: articles,
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit),
		});
	} catch (error) {
		console.log(error);
		res.status(500).json({
			success: false,
			message: 'Error fetching articles',
		});
	}
});

//? Get trending articles
app.get('/articles/trending', async (req, res) => {
	try {
		const articles = await articlesCollection.find({ status: 'approved' }).sort({ views: -1 }).limit(6).toArray();
		res.json({
			success: true,
			data: articles,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching trending articles',
		});
	}
});

//? Get premium articles
app.get('/articles/premium', verifyUser, verifySubscription, async (req, res) => {
	try {
		const page = Number.parseInt(req.query.page) || 1;
		const limit = Number.parseInt(req.query.limit) || 10;
		const skip = (page - 1) * limit;

		const search = req.query.search || '';
		const publisher = req.query.publisher || '';
		const tags = req.query.tags ? req.query.tags.split(',') : [];

		const matchStage = {
			isPremium: true,
			status: 'approved',
		};

		if (search) {
			matchStage.$or = [{ title: { $regex: search, $options: 'i' } }, { content: { $regex: search, $options: 'i' } }];
		}

		if (publisher) {
			matchStage.publisher = new ObjectId(publisher);
		}

		if (tags.length > 0) {
			matchStage.tags = { $elemMatch: { value: { $in: tags } } };
		}

		const [articles, total] = await Promise.all([
			articlesCollection
				.aggregate([
					{
						$addFields: {
							publisher: {
								$cond: {
									if: { $eq: [{ $type: '$publisher' }, 'string'] },
									then: { $toObjectId: '$publisher' },
									else: '$publisher',
								},
							},
						},
					},
					{
						$match: matchStage,
					},
					{
						$lookup: {
							from: 'publishers',
							localField: 'publisher',
							foreignField: '_id',
							as: 'author',
						},
					},
					{
						$unwind: '$author',
					},
					{
						$sort: { createdAt: -1 },
					},
					{
						$skip: skip,
					},
					{
						$limit: limit,
					},
				])
				.toArray(),
			articlesCollection.countDocuments(matchStage),
		]);

		res.json({
			success: true,
			data: articles,
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit),
		});
	} catch (error) {
		console.log(error);
		res.status(500).json({
			success: false,
			message: 'Error fetching premium articles',
		});
	}
});

//? Get single article
app.get('/articles/:id', verifyUser, async (req, res) => {
	try {
		const article = await articlesCollection.findOne({
			_id: new ObjectId(req.params.id),
		});

		if (!article) {
			return res.status(404).json({
				success: false,
				message: 'Article not found',
			});
		}

		res.json({
			success: true,
			data: article,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching article',
		});
	}
});

//? Add article
app.post('/articles', verifyUser, async (req, res) => {
	try {
		const email = req.decoded.email;
		// Get user subscription status
		const user = await usersCollection.findOne({ email }, { projection: { hasSubscription: 1, subscriptionEnd: 1 } });

		if (!user) {
			return res.status(404).json({
				success: false,
				message: 'User not found',
			});
		}
		// Check subscription status and expiry
		const hasValidSubscription =
			user.hasSubscription && (!user.subscriptionEnd || new Date(user.subscriptionEnd) > new Date());

		// If not subscribed, check article count
		if (!hasValidSubscription) {
			const articleCount = await articlesCollection.countDocuments({ authorEmail: email });
			if (articleCount >= 1) {
				return res.status(403).json({
					success: false,
					message: 'Subscribe to post more than one article',
				});
			}
		}

		const article = req.body;
		const requiredFields = ['title', 'image', 'publisher', 'tags', 'description', 'content', 'authorEmail'];

		// Validate required fields
		for (const field of requiredFields) {
			if (!article[field]) {
				return res.status(400).json({
					success: false,
					message: `${field} is required`,
				});
			}
		}

		// Add metadata
		article.createdAt = new Date();
		article.updatedAt = new Date();
		article.status = 'pending';
		article.views = 0;
		article.ratings = [];
		article.averageRating = 0;

		const result = await articlesCollection.insertOne(article);

		if (!result.insertedId) {
			return res.status(400).json({
				success: false,
				message: 'Failed to add article',
			});
		}

		res.status(201).json({
			success: true,
			message: 'Article added successfully',
			data: result,
		});
	} catch (error) {
		console.error('Add Article Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error adding article',
		});
	}
});

//? Get user's articles (My Articles)
app.get('/articles/my-articles/:email', verifyUser, async (req, res) => {
	const email = req.params.email;
	const page = parseInt(req.query.page) || 1;
	const limit = parseInt(req.query.limit) || 10;
	const skip = (page - 1) * limit;
	if (email !== req.decoded.email) {
		return res.status(403).json({
			success: false,
			message: 'Forbidden access',
		});
	}
	try {
		const [articles, total] = await Promise.all([
			articlesCollection.find({ authorEmail: email }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
			articlesCollection.countDocuments({ authorEmail: email }),
		]);
		res.json({
			success: true,
			data: {
				articles,
				total,
				page,
				limit,
				totalPages: Math.ceil(total / limit),
			},
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching articles',
		});
	}
});

//? Get users articles (Add Article Verify)
app.get('/articles/user/:email', verifyUser, async (req, res) => {
	try {
		const { email } = req.params;

		// Verify if the requesting user is the same as the email parameter
		if (req.decoded.email !== email) {
			return res.status(403).json({
				success: false,
				message: 'Unauthorized access',
			});
		}

		const articles = await articlesCollection
			.find({ authorEmail: email })
			.project({
				title: 1,
				status: 1,
				createdAt: 1,
				isPremium: 1,
			})
			.toArray();

		res.json({
			success: true,
			data: articles,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching user articles',
		});
	}
});

//? Update article
app.patch('/articles/:id', verifyUser, async (req, res) => {
	try {
		const { id } = req.params;
		const updates = req.body;

		// Verify if the user is the author
		const article = await articlesCollection.findOne({ _id: new ObjectId(id) });
		if (!article) {
			return res.status(404).json({
				success: false,
				message: 'Article not found',
			});
		}

		if (article.authorEmail !== req.decoded.email) {
			return res.status(403).json({
				success: false,
				message: 'Unauthorized access',
			});
		}

		const result = await articlesCollection.updateOne({ _id: new ObjectId(id) }, { $set: updates });

		if (result.modifiedCount === 0) {
			return res.status(400).json({
				success: false,
				message: 'Failed to update article',
			});
		}

		res.json({
			success: true,
			message: 'Article updated successfully',
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error updating article',
		});
	}
});

//? Delete Article
app.delete('/articles/:id', verifyUser, async (req, res) => {
	try {
		const result = await articlesCollection.deleteOne({
			_id: new ObjectId(req.params.id),
		});

		if (result.deletedCount === 0) {
			return res.status(404).json({
				success: false,
				message: 'Article not found',
			});
		}

		res.json({
			success: true,
			message: 'Article deleted successfully',
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error deleting article',
		});
	}
});

// NOTE: ALL API RELATED TO PUBLISHER
//? Add Publisher
app.post('/publishers', verifyUser, verifyAdmin, async (req, res) => {
	const { name, logo } = req.body;
	try {
		if (!name || !logo) {
			return res.status(400).json({
				success: false,
				message: 'Name and logo are required',
			});
		}

		const result = await publishersCollection.insertOne({
			name,
			logo,
			createdAt: new Date(),
		});

		res.status(201).json({
			success: true,
			message: 'Publisher added successfully',
			data: result,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error adding publisher',
		});
	}
});

//? Get Publishers
app.get('/publishers', async (req, res) => {
	try {
		const publishers = await publishersCollection.find().toArray();
		res.status(201).json({
			success: true,
			message: 'Publisher added successfully',
			data: publishers,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error adding publisher',
		});
	}
});

// NOTE: MONGODB
async function run() {
	try {
		await client.connect();
		await client.db('admin').command({ ping: 1 });
		console.log('Pinged your deployment. You successfully connected to MongoDB!');
	} finally {
	}
}
run().catch(console.dir);

// NOTE: Root endpoint
app.get('/', (req, res) => {
	res.send('Hello, Restaurant is serving');
});

app.listen(port, () => {
	console.log('Herald is serving knowledge on port:', port);
});
