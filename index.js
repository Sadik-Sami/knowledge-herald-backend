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

// NOTE: MONGODB
async function run() {
	try {
		await client.connect();
		await client.db('admin').command({ ping: 1 });
		console.log('Pinged your deployment. You successfully connected to MongoDB!');
	} finally {
	}
}

// NOTE: Root endpoint
app.get('/', (req, res) => {
	res.send('Hello, Restaurant is serving');
});

app.listen(port, () => {
	console.log('Herald is serving knowledge on port:', port);
});
