const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { authenticateApiKey } = require('../middleware/auth');

// Get all users with pagination
router.get('/users', authenticateApiKey, async (req, res) => {
    try {
        const { page = 1, limit = 10, status, plan } = req.query;
        const offset = (page - 1) * limit;

        let query = supabase
            .from('users')
            .select('*', { count: 'exact' });

        if (status) query = query.eq('status', status);
        if (plan) query = query.eq('plan', plan);

        query = query
            .order('created_at', { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);

        const { data: users, count, error } = await query;

        if (error) throw error;

        res.json({
            users: users,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: count,
                hasMore: count > offset + parseInt(limit)
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

        // Upsert user
        const upsertData = {
            email,
            ...customFields,
            updated_at: new Date().toISOString()
        };

        if (plan) upsertData.plan = plan;
        if (status) upsertData.status = status;

        const { data, error } = await supabase
            .from('users')
            .upsert(upsertData, { onConflict: 'email' })
            .select()
            .single();

        if (error) throw error;

        res.json({ action: 'upserted', user: data });

    } catch (error) {
        console.error('Error creating/updating user:', error);
        res.status(500).json({ error: 'Failed to create/update user' });
    }
});

// Delete user
router.delete('/users/:email', authenticateApiKey, async (req, res) => {
    try {
        const { email } = req.params;

        const { error } = await supabase
            .from('users')
            .delete()
            .ilike('email', email);

        if (error) throw error;

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

        let query = supabase.from('users').select('*');

        if (startDate) query = query.gte('created_at', startDate);
        if (endDate) query = query.lte('created_at', endDate);

        const { data: users, error } = await query;

        if (error) throw error;

        // Calculate analytics
        const analytics = {
            total_users: users.length,
            active_subscriptions: users.filter(u => u.status === 'active').length,
            past_due_users: users.filter(u => u.status === 'past_due').length,
            canceled_users: users.filter(u => u.status === 'canceled').length,
            pending_users: users.filter(u => u.status === 'pending').length,
            plans: {},
            revenue_estimate: 0
        };

        // Count by plan
        users.forEach(user => {
            const plan = user.plan || 'free';
            analytics.plans[plan] = (analytics.plans[plan] || 0) + 1;

            if (user.status === 'active') {
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

module.exports = router;
