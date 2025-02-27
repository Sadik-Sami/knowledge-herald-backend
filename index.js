require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SK);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3b45u.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const port = process.env.PORT || 5000;

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
const contactCollection = client.db('heraldDB').collection('contacts');

//NOTE: MIDDLEWARES
app.use(
	cors({
		origin: ['https://knowledge-herald.web.app', 'http://localhost:5173'],
	})
);
// app.use(cors());
app.use(express.json());

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

// NOTE: ALL API RELATED TO PAYMENT
//? Create payment session
app.post('/create-payment-intent', verifyUser, async (req, res) => {
	try {
		const { planId, email } = req.body;
		// Get plan from database
		const plan = await plansCollection.findOne({ _id: new ObjectId(planId) });
		if (!plan) {
			return res.status(400).json({
				success: false,
				message: 'Invalid plan selected',
			});
		}

		// Convert duration to minutes based on unit
		const durationInMinutes =
			plan.duration *
			(plan.durationUnit === 'minute'
				? 1
				: plan.durationUnit === 'days'
				? 24 * 60
				: plan.durationUnit === 'months'
				? 30 * 24 * 60
				: 0);

		const session = await stripe.checkout.sessions.create({
			payment_method_types: ['card'],
			line_items: [
				{
					price_data: {
						currency: 'usd',
						product_data: {
							name: `${plan.name} - ${plan.duration} ${plan.durationUnit}`,
							description: plan.description,
						},
						unit_amount: Math.round(plan.price * 100), // Convert to cents
					},
					quantity: 1,
				},
			],
			mode: 'payment',
			success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${process.env.CLIENT_URL}/subscription`,
			customer_email: email,
			metadata: {
				planId: plan.id,
				duration: durationInMinutes.toString(),
				planName: plan.name,
			},
		});

		res.json({
			success: true,
			sessionId: session.id,
		});
	} catch (error) {
		console.error('Payment Intent Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error creating payment session',
		});
	}
});

//? successful payment
app.get('/payment/success', async (req, res) => {
	try {
		const session = await stripe.checkout.sessions.retrieve(req.query.session_id);

		if (session.payment_status === 'paid') {
			const payment = {
				email: session.customer_email,
				paymentId: session.payment_intent,
				planId: session.metadata.planId,
				planName: session.metadata.planName,
				subscriptionTime: Number.parseInt(session.metadata.duration),
				amount: session.amount_total,
				createdAt: new Date(),
				status: 'success',
			};

			await paymentsCollection.insertOne(payment);

			// Update user subscription status
			await usersCollection.updateOne(
				{ email: session.customer_email },
				{
					$set: {
						hasSubscription: true,
						subscriptionEnd: new Date(Date.now() + Number.parseInt(session.metadata.duration) * 60 * 1000),
					},
				}
			);

			res.json({
				success: true,
				message: 'Payment processed successfully',
			});
		} else {
			throw new Error('Payment not successful');
		}
	} catch (error) {
		console.error('Payment Success Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error processing payment',
		});
	}
});

//? Get plans
app.get('/plans', async (req, res) => {
	try {
		const plans = await plansCollection.find().toArray();
		res.json({ success: true, data: plans });
	} catch (error) {
		res.status(500).json({ success: false, message: 'Error fetching plans' });
	}
});

// NOTE: All API RELATED TO INTERACTING WITH ARTICLES

//? Increase View on visit
app.post('/articles/:id/view', async (req, res) => {
	try {
		await articlesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $inc: { views: 1 } });

		res.json({
			success: true,
			message: 'View count updated',
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error updating view count',
		});
	}
});

//? Get Comments
app.get('/articles/:id/comments', verifyUser, async (req, res) => {
	try {
		const comments = await commentsCollection.find({ articleId: req.params.id }).sort({ createdAt: -1 }).toArray();

		res.json({
			success: true,
			data: comments,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching comments',
		});
	}
});

//? Add comment
app.post('/articles/:id/comments', verifyUser, async (req, res) => {
	try {
		const comment = {
			...req.body,
			createdAt: new Date(),
		};

		const result = await commentsCollection.insertOne(comment);

		// Update article rating
		const comments = await commentsCollection.find({ articleId: req.params.id }).toArray();

		const totalRating = comments.reduce((sum, comment) => sum + comment.rating, 0);
		const averageRating = totalRating / comments.length;

		await articlesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { averageRating } });

		res.json({
			success: true,
			message: 'Comment added successfully',
			data: result,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error adding comment',
		});
	}
});

// NOTE: ALL API RELATED TO GETTING STATS
//? Get Site Stats
app.get('/stats', async (req, res) => {
	try {
		const [totalUsers, freeArticles, premiumArticles, publishers, subscribedUsers] = await Promise.all([
			usersCollection.countDocuments(),
			articlesCollection.countDocuments({ isPremium: false, status: 'approved' }),
			articlesCollection.countDocuments({ isPremium: true, status: 'approved' }),
			publishersCollection.countDocuments(),
			usersCollection.countDocuments({ hasSubscription: true }),
		]);

		res.json({
			success: true,
			data: {
				totalUsers,
				freeArticles,
				premiumArticles,
				publishers,
				subscribedUsers,
			},
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching stats',
		});
	}
});

//? Get Admin Stats
app.get('/admin/stats', verifyUser, verifyAdmin, async (req, res) => {
	try {
		// Get basic stats
		const [totalUsers, totalArticles, premiumArticles, totalPublishers, totalViews, totalComments, totalRatings] =
			await Promise.all([
				usersCollection.countDocuments(),
				articlesCollection.countDocuments({ status: 'approved' }),
				articlesCollection.countDocuments({ status: 'approved', isPremium: true }),
				publishersCollection.countDocuments(),
				articlesCollection.aggregate([{ $group: { _id: null, total: { $sum: '$views' } } }]).toArray(),
				commentsCollection.countDocuments(),
				commentsCollection.countDocuments({ rating: { $exists: true } }),
			]);

		const publicationDistribution = await articlesCollection
			.aggregate([
				{
					$group: {
						_id: '$publisherName',
						count: { $sum: 1 },
					},
				},
				{
					$project: {
						_id: 0,
						name: '$_id',
						count: 1,
					},
				},
			])
			.toArray();

		res.json({
			success: true,
			data: {
				totalUsers,
				totalArticles,
				premiumArticles,
				totalPublishers,
				totalViews: totalViews[0]?.total || 0,
				totalComments,
				totalRatings,
				publicationDistribution,
			},
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			message: 'Error fetching admin statistics',
		});
	}
});

app.get('/user-stats', verifyUser, async (req, res) => {
	try {
		const { email } = req.query;

		if (!email) {
			return res.status(400).json({
				success: false,
				message: 'Email is required',
			});
		}

		// Get the date 30 days ago
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		thirtyDaysAgo.setHours(0, 0, 0, 0);

		// Generate an array of the last 30 days
		const last30Days = Array.from({ length: 30 }, (_, i) => {
			const date = new Date();
			date.setDate(date.getDate() - i);
			date.setHours(0, 0, 0, 0);
			return date;
		}).reverse();

		// Get views data aggregated by day
		const viewsData = await articlesCollection
			.aggregate([
				{
					$match: {
						authorEmail: email,
						// createdAt: { $gte: thirtyDaysAgo },
					},
				},
				{
					$group: {
						// _id: {
						// 	$dateToString: {
						// 		format: '%Y-%m-%d',
						// 		date: '$createdAt',
						// 	},
						// },
						_id: new ObjectId(),
						views: { $sum: '$views' },
					},
				},
				// {
				// 	$sort: { _id: 1 },
				// },
			])
			.toArray();

		// Create a map of date to views
		const viewsMap = new Map(viewsData.map((item) => [item._id, item.views]));
		console.log(viewsData);
		// Fill in missing dates with zero views
		const filledViewsData = last30Days.map((date) => ({
			date: date.toISOString().split('T')[0],
			views: viewsMap.get(date.toISOString().split('T')[0]) || 0,
		}));

		// Get posts data aggregated by day
		const postsData = await articlesCollection
			.aggregate([
				{
					$match: {
						authorEmail: email,
						createdAt: { $gte: thirtyDaysAgo },
					},
				},
				{
					$group: {
						_id: {
							$dateToString: {
								format: '%Y-%m-%d',
								date: '$createdAt',
							},
						},
						posts: { $sum: 1 },
					},
				},
				{
					$sort: { _id: 1 },
				},
			])
			.toArray();

		// Create a map of date to posts
		const postsMap = new Map(postsData.map((item) => [item._id, item.posts]));

		// Fill in missing dates with zero posts
		const filledPostsData = last30Days.map((date) => ({
			date: date.toISOString().split('T')[0],
			posts: postsMap.get(date.toISOString().split('T')[0]) || 0,
		}));

		// Get total stats
		const stats = await articlesCollection
			.aggregate([
				{
					$match: { authorEmail: email },
				},
				{
					$group: {
						_id: null,
						totalPosts: { $sum: 1 },
						totalViews: { $sum: '$views' },
						averageRating: { $avg: '$averageRating' },
					},
				},
			])
			.toArray();

		// Calculate growth percentages
		const previousMonthStats = await articlesCollection
			.aggregate([
				{
					$match: {
						authorEmail: email,
						createdAt: {
							$gte: new Date(new Date().setDate(new Date().getDate() - 60)),
							$lt: thirtyDaysAgo,
						},
					},
				},
				{
					$group: {
						_id: null,
						previousViews: { $sum: '$views' },
						previousPosts: { $sum: 1 },
					},
				},
			])
			.toArray();

		const currentStats = stats[0] || { totalPosts: 0, totalViews: 0, averageRating: 0 };
		const previousStats = previousMonthStats[0] || { previousViews: 0, previousPosts: 0 };

		const viewsGrowth = previousStats.previousViews
			? ((currentStats.totalViews - previousStats.previousViews) / previousStats.previousViews) * 100
			: 0;

		const postsGrowth = previousStats.previousPosts
			? ((currentStats.totalPosts - previousStats.previousPosts) / previousStats.previousPosts) * 100
			: 0;

		// Get articles with views
		const articles = await articlesCollection
			.find({ authorEmail: email })
			.project({
				title: 1,
				views: 1,
				createdAt: 1,
				image: 1,
			})
			.sort({ views: -1 })
			.limit(6)
			.toArray();

		res.json({
			success: true,
			stats: {
				...currentStats,
				viewsGrowth: Math.round(viewsGrowth),
				postsGrowth: Math.round(postsGrowth),
				viewsData: filledViewsData,
				postsData: filledPostsData,
				articles,
			},
		});
	} catch (error) {
		console.error('Dashboard Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error fetching dashboard data',
		});
	}
});

// TODO:Contact
app.post('/contact', async (req, res) => {
	try {
		const { name, email, subject, message } = req.body;

		// Validate required fields
		if (!name || !email || !subject || !message) {
			return res.status(400).json({
				success: false,
				message: 'All fields are required',
			});
		}

		// Validate email format
		const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
		if (!emailRegex.test(email)) {
			return res.status(400).json({
				success: false,
				message: 'Invalid email format',
			});
		}

		// Create contact message document
		const contactMessage = {
			name,
			email,
			subject,
			message,
			createdAt: new Date(),
			status: 'unread',
		};

		// Insert into database
		const result = await contactCollection.insertOne(contactMessage);

		if (!result.insertedId) {
			throw new Error('Failed to save contact message');
		}

		res.status(201).json({
			success: true,
			message: 'Message sent successfully',
		});
	} catch (error) {
		console.error('Contact Form Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error sending message',
		});
	}
});
app.get('/messages', async (req, res) => {
	try {
		const messages = await contactCollection.find({}).sort({ createdAt: -1 }).toArray();
		res.json({
			success: true,
			data: messages,
		});
	} catch (error) {
		console.error('Get Contact Messages Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error fetching contact messages',
		});
	}
});
app.patch('/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const { status } = req.body;

		if (!['read', 'unread', 'archived'].includes(status)) {
			return res.status(400).json({
				success: false,
				message: 'Invalid status',
			});
		}

		const result = await contactCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status } });

		if (result.modifiedCount === 0) {
			return res.status(404).json({
				success: false,
				message: 'Message not found',
			});
		}

		res.json({
			success: true,
			message: 'Message status updated successfully',
		});
	} catch (error) {
		console.error('Update Contact Message Error:', error);
		res.status(500).json({
			success: false,
			message: 'Error updating message status',
		});
	}
});

// NOTE: MONGODB
async function run() {
	try {
		// await client.connect();
		// await client.db('admin').command({ ping: 1 });
		// console.log('Pinged your deployment. You successfully connected to MongoDB!');
	} finally {
	}
}
run().catch(console.dir);

// NOTE: Root endpoint
app.get('/', (req, res) => {
	res.send('Hello, Heral is serving knowledge');
});

app.listen(port, () => {
	console.log('Herald is serving knowledge on port:', port);
});
