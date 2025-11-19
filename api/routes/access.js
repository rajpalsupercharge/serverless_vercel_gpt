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
    let records = await base('Users').select({
      filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
      maxRecords: 1
    }).firstPage();

    // If user doesn't exist, create them in Airtable
    let userCreated = false;
    if (records.length === 0) {
      try {
        console.log(`Creating new user in Airtable: ${email}`);
        // Create user without Status - Status field is optional
        // Only set Status if you have a valid option in your Airtable Status field
        // Status can be set later via API or manually in Airtable
        const userFields = {
          Email: email
          // Status is not set - will be null/empty until set via webhook or manually
        };
        
        // Only set Plan if 'free' is a valid option in your Airtable
        // If not, remove this line or set to a valid option
        // userFields.Plan = 'free';
        
        const newRecords = await base('Users').create([
          {
            fields: userFields
            // CreatedAt and UpdatedAt are auto-managed by Airtable (computed fields)
          }
        ]);
        records = newRecords;
        userCreated = true;
        console.log(`✅ User created in Airtable: ${email}`);
      } catch (airtableError) {
        console.error('Error creating user in Airtable:', airtableError);
        // Continue even if Airtable creation fails - return no access
        return res.json({
          has_access: false,
          plan: null,
          status: null,
          current_period_end: null,
          message: 'User not found and could not be created'
        });
      }
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
      current_period_end: periodEnd ? periodEnd.toISOString() : null,
      user_created: userCreated // Indicates if user was just created
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
