require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SK);
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3b45u.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

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
