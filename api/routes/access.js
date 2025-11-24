const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { authenticateApiKey } = require('../middleware/auth');

// Check user access
router.get('/check-access', authenticateApiKey, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user in Supabase
    const { data: users, error: findError } = await supabase
      .from('users')
      .select('*')
      .ilike('email', email)
      .limit(1);

    if (findError) {
      console.error('Error finding user:', findError);
      throw findError;
    }

    let user = users && users.length > 0 ? users[0] : null;
    let userCreated = false;

    // If user doesn't exist, create them
    if (!user) {
      try {
        console.log(`Creating new user in Supabase: ${email}`);
        const { data: newUser, error: createError } = await supabase
          .from('users')
          .insert([{ email: email }])
          .select()
          .single();

        if (createError) throw createError;

        user = newUser;
        userCreated = true;
        console.log(`✅ User created in Supabase: ${email}`);
      } catch (createError) {
        console.error('Error creating user in Supabase:', createError);
        return res.json({
          has_access: false,
          plan: null,
          status: null,
          current_period_end: null,
          message: 'User not found and could not be created'
        });
      }
    }

    const now = new Date();
    const periodEnd = user.current_period_end ? new Date(user.current_period_end) : null;

    // Check if subscription is active
    // We check if status is active OR if they are in a trial/grace period that hasn't expired
    const hasAccess = (user.status === 'active' || user.status === 'trialing') && periodEnd && periodEnd > now;

    res.json({
      has_access: hasAccess,
      plan: user.plan || null,
      status: user.status || null,
      current_period_end: periodEnd ? periodEnd.toISOString() : null,
      user_created: userCreated
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

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .ilike('email', email)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      plan: user.plan,
      status: user.status,
      customer_id: user.stripe_customer_id,
      created_at: user.created_at,
      updated_at: user.updated_at
    });

  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;

