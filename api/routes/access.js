const express = require('express');
const router = express.Router();
const Airtable = require('airtable');
const { authenticateApiKey } = require('../middleware/auth');

// Initialize Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Check user access
router.get('/check-access', authenticateApiKey, async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user in Airtable
    const records = await base('Users').select({
      filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.json({
        has_access: false,
        plan: null,
        status: null,
        current_period_end: null
      });
    }

    const user = records[0].fields;
    const now = new Date();
    const periodEnd = user.CurrentPeriodEnd ? new Date(user.CurrentPeriodEnd) : null;
    
    // Check if subscription is active
    const hasAccess = user.Status === 'active' && periodEnd && periodEnd > now;

    res.json({
      has_access: hasAccess,
      plan: user.Plan || null,
      status: user.Status || null,
      current_period_end: periodEnd ? periodEnd.toISOString() : null
    });

  } catch (error) {
    console.error('Error checking access:', error);
    res.status(500).json({ error: 'Failed to check access' });
  }
});

// Get user details
router.get('/user/:email', authenticateApiKey, async (req, res) => {
  try {
    const { email } = req.params;
    
    const records = await base('Users').select({
      filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = records[0];
    res.json({
      id: user.id,
      email: user.fields.Email,
      plan: user.fields.Plan,
      status: user.fields.Status,
      customer_id: user.fields.StripeCustomerId,
      created_at: user.fields.CreatedAt,
      updated_at: user.fields.UpdatedAt
    });

  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
