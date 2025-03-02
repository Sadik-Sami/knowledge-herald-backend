# Herald API - Knowledge Serving Platform

## Overview
Herald is a knowledge-sharing platform that allows users to read, write, and manage articles. It provides subscription-based access to premium content, user authentication, role-based access control, and secure payments using Stripe.

## Features
- **User Authentication**: JWT-based authentication.
- **Role Management**: User and Admin roles with different permissions.
- **Subscription Management**: Users can subscribe to access premium content.
- **Article Management**: Create, read, update, and delete articles.
- **Payment Integration**: Stripe-powered payments.
- **Commenting System**: Users can comment and rate articles.
- **Admin Dashboard**: Manage users, articles, and statistics.
- **MongoDB Database**: Used for storing user, article, and payment data.

## Tech Stack
- **Backend**: Node.js, Express.js
- **Database**: MongoDB (Atlas)
- **Authentication**: JWT
- **Payments**: Stripe
- **Hosting**: Deployed on a cloud server

## Installation
### Prerequisites
Ensure you have the following installed:
- Node.js (latest LTS version recommended)
- MongoDB Atlas account
- Stripe API keys

### Setup
1. Clone the repository:
   ```sh
   git clone https://github.com/your-username/herald-api.git
   cd herald-api
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Create a `.env` file in the root directory and add the following:
   ```env
   PORT=5000
   DB_USER=yourMongoDBUser
   DB_PASSWORD=yourMongoDBPassword
   JWT_SECRET=yourJWTSecretKey
   STRIPE_SK=yourStripeSecretKey
   CLIENT_URL=http://localhost:5173
   ```
4. Start the server:
   ```sh
   npm start
   ```

## API Endpoints
### Authentication
- **`POST /auth/login`** - Authenticate user and return JWT token.

### Users
- **`GET /users`** - Get all users (Admin only).
- **`POST /users`** - Add a new user.
- **`PATCH /users/profile`** - Update user profile.
- **`GET /users/admin/:email`** - Check if a user is an admin.

### Articles
- **`GET /articles`** - Fetch all articles.
- **`GET /articles/:id`** - Get a specific article.
- **`POST /articles`** - Create a new article.
- **`PATCH /articles/:id`** - Update an article.
- **`DELETE /articles/:id`** - Delete an article.

### Payments
- **`POST /create-payment-intent`** - Initiate a payment session with Stripe.
- **`GET /payment/success`** - Handle successful payments.

### Comments
- **`GET /articles/:id/comments`** - Get comments for an article.
- **`POST /articles/:id/comments`** - Add a comment to an article.

### Admin
- **`PATCH /make-admin/:id`** - Assign admin role to a user.
- **`PATCH /admin/articles/:id`** - Approve/reject articles.

### Stats
- **`GET /stats`** - Get platform statistics.
- **`GET /admin/stats`** - Get admin-related stats.

## Deployment
1. Set up a cloud hosting service (e.g., Heroku, Vercel, DigitalOcean).
2. Configure environment variables in the hosting platform.
3. Deploy the application using.

## License
This project is licensed under the MIT License.

## Contact
For any issues, contact [sadik.al.sami.2002@gmail.com](mailto:sadik.al.sami.2002@gmail.com).

