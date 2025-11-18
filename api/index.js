require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const rateLimit = require("express-rate-limit");
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set('trust proxy', 1); // trust first proxy (Vercel)

// Rate limiting with Vercel-compatible store
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  // Important: Use memory store for Vercel
  skipSuccessfulRequests: false
});

// CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'https://chat.openai.com',
      'https://chatgpt.com',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);
    
    if (process.env.NODE_ENV !== 'production') {
      // Allow all origins in development
      return callback(null, true);
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization']
}));

// Body parsing middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Import routes (we'll create these next)
const accessRoutes = require('./routes/access');
const stripeRoutes = require('./routes/stripe');
const airtableRoutes = require('./routes/airtable');

// Health check
app.get('/api', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    message: 'GPT Paywall API is running on Vercel',
    timestamp: new Date().toISOString()
  });
});

// Apply rate limiting to all routes
app.use('/api/', limiter);

// Use routes
app.use('/api', accessRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/airtable', airtableRoutes);

// Handle OPTIONS requests for CORS preflight
app.options('*', cors());

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy violation' });
  }
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// IMPORTANT: Export for Vercel
module.exports = app;
