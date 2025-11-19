const express = require('express');
const router = express.Router();
const Airtable = require('airtable');
const { authenticateApiKey } = require('../middleware/auth');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Get all users with pagination
router.get('/users', authenticateApiKey, async (req, res) => {
  try {
    const { page = 1, limit = 10, status, plan } = req.query;
    const offset = (page - 1) * limit;
    
    let filterFormula = [];
    if (status) filterFormula.push(`{Status} = '${status}'`);
    if (plan) filterFormula.push(`{Plan} = '${plan}'`);
    
    const formula = filterFormula.length > 0 ? 
      `AND(${filterFormula.join(',')})` : '';

    const users = [];
    
    await base('Users').select({
      pageSize: parseInt(limit),
      filterByFormula: formula,
      sort: [{ field: 'CreatedAt', direction: 'desc' }]
    }).eachPage((records, fetchNextPage) => {
      records.forEach(record => {
        users.push({
          id: record.id,
          ...record.fields
        });
      });
      
      if (users.length >= offset + limit) {
        return; // Stop fetching
      }
      fetchNextPage();
    });

    const paginatedUsers = users.slice(offset, offset + limit);
    
    res.json({
      users: paginatedUsers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: users.length,
        hasMore: users.length > offset + limit
      }
    });

  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create or update user
router.post('/users', authenticateApiKey, async (req, res) => {
  try {
    const { email, plan, status, customFields = {} } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if user exists
    const existingRecords = await base('Users').select({
      filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
      maxRecords: 1
    }).firstPage();

    let result;
    
    if (existingRecords.length > 0) {
      // Update existing user
      const updateFields = {};
      
      if (plan) updateFields.Plan = plan;
      if (status) updateFields.Status = status;
      Object.assign(updateFields, customFields);
      // UpdatedAt is auto-managed by Airtable (computed field)
      
      const updated = await base('Users').update([
        {
          id: existingRecords[0].id,
          fields: updateFields
        }
      ]);
      
      result = { action: 'updated', user: updated[0].fields };
    } else {
      // Create new user
      // Build fields object - only include Status if provided and valid
      const createFields = {
        Email: email
      };
      
      // Only set Plan if provided or if 'free' is a valid option
      if (plan) {
        createFields.Plan = plan;
      }
      // Don't default to 'free' - let Airtable handle defaults
      
      // Only set Status if explicitly provided (must match Airtable options)
      if (status) {
        createFields.Status = status;
      }
      // Don't default to 'pending' - Status must match valid Airtable options
      
      Object.assign(createFields, customFields);
      
      const created = await base('Users').create([
        {
          fields: createFields
          // CreatedAt and UpdatedAt are auto-managed by Airtable (computed fields)
        }
      ]);
      
      result = { action: 'created', user: created[0].fields };
    }

    res.json(result);

  } catch (error) {
    console.error('Error creating/updating user:', error);
    res.status(500).json({ error: 'Failed to create/update user' });
  }
});

// Delete user
router.delete('/users/:email', authenticateApiKey, async (req, res) => {
  try {
    const { email } = req.params;
    
    const records = await base('Users').select({
      filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await base('Users').destroy([records[0].id]);
    
    res.json({ message: 'User deleted successfully' });

  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Analytics endpoint
router.get('/analytics', authenticateApiKey, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let filterFormula = '';
    if (startDate && endDate) {
      filterFormula = `AND(
        IS_AFTER({CreatedAt}, '${startDate}'),
        IS_BEFORE({CreatedAt}, '${endDate}')
      )`;
    }

    const records = [];
    await base('Users').select({
      filterByFormula: filterFormula
    }).eachPage((pageRecords, fetchNextPage) => {
      records.push(...pageRecords);
      fetchNextPage();
    });

    // Calculate analytics
    // Status options: active, trailing, canceled, none, pending
    const analytics = {
      total_users: records.length,
      active_subscriptions: records.filter(r => r.fields.Status === 'active').length,
      trailing_users: records.filter(r => r.fields.Status === 'trailing').length,
      canceled_users: records.filter(r => r.fields.Status === 'canceled').length,
      pending_users: records.filter(r => r.fields.Status === 'pending').length,
      none_users: records.filter(r => r.fields.Status === 'none' || !r.fields.Status).length,
      plans: {},
      revenue_estimate: 0
    };

    // Count by plan
    records.forEach(record => {
      const plan = record.fields.Plan || 'free';
      analytics.plans[plan] = (analytics.plans[plan] || 0) + 1;
      
      // Estimate revenue (you'll need to adjust prices)
      if (record.fields.Status === 'active') {
        const planPrices = {
          'pro': 29,
          'premium': 49,
          'enterprise': 99
        };
        analytics.revenue_estimate += planPrices[plan] || 0;
      }
    });

    res.json(analytics);

  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Bulk operations
router.post('/users/bulk', authenticateApiKey, async (req, res) => {
  try {
    const { action, emails, updates } = req.body;

    if (!action || !emails || !Array.isArray(emails)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const results = [];

    for (const email of emails) {
      try {
        const records = await base('Users').select({
          filterByFormula: `LOWER({Email}) = LOWER('${email.toLowerCase()}')`,
          maxRecords: 1
        }).firstPage();

        if (records.length > 0) {
          if (action === 'update' && updates) {
            await base('Users').update([
              {
                id: records[0].id,
                fields: {
                  ...updates
                  // UpdatedAt is auto-managed by Airtable (computed field)
                }
              }
            ]);
            results.push({ email, status: 'updated' });
          } else if (action === 'delete') {
            await base('Users').destroy([records[0].id]);
            results.push({ email, status: 'deleted' });
          }
        } else {
          results.push({ email, status: 'not_found' });
        }
      } catch (error) {
        results.push({ email, status: 'error', error: error.message });
      }
    }

    res.json({ results });

  } catch (error) {
    console.error('Error in bulk operation:', error);
    res.status(500).json({ error: 'Bulk operation failed' });
  }
});

module.exports = router;
