// API Key authentication middleware
function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key is required' });
  }

  // Validate API key
  const validApiKey = process.env.GPT_API_KEY;
  
  if (apiKey !== validApiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
}

// Optional: Add rate limiting per API key
const apiKeyRateLimits = new Map();

function rateLimitByApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return next();
  }

  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 30; // 30 requests per minute per API key

  if (!apiKeyRateLimits.has(apiKey)) {
    apiKeyRateLimits.set(apiKey, { count: 1, resetTime: now + windowMs });
    return next();
  }

  const limit = apiKeyRateLimits.get(apiKey);
  
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + windowMs;
  } else {
    limit.count++;
    
    if (limit.count > maxRequests) {
      return res.status(429).json({ 
        error: 'Too many requests', 
        retryAfter: Math.ceil((limit.resetTime - now) / 1000) 
      });
    }
  }

  next();
}

module.exports = {
  authenticateApiKey,
  rateLimitByApiKey
};
