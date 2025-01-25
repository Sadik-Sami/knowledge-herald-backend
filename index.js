require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SK);
const port = process.env.PORT || 5000;


// NOTE: Root endpoint
app.get('/', (req, res) => {
	res.send('Hello, Restaurant is serving');
});

app.listen(port, () => {
	console.log('Herald is serving knowledge on port:', port);
});
