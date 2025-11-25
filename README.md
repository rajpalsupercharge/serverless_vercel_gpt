# GPT Paywall - Vercel & Supabase Edition

A serverless API to monetize your GPTs using Stripe and Supabase. Deploy easily to Vercel.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frajpalsupercharge%2Fserverless_vercel_gpt&env=STRIPE_SECRET_KEY,STRIPE_PRICE_ID,STRIPE_WEBHOOK_SECRET,SUPABASE_URL,SUPABASE_KEY,GPT_API_KEY)

🚀 Features

- **Stripe Integration**: Subscriptions, one-time payments, and customer portal.
- **Supabase Database**: Store user data and subscription status securely.
- **GPT Authentication**: Secure your API with API keys.
- **OpenAPI Spec**: Ready-to-use specification for GPT Actions.
- **Resend Invoice**: Endpoint to handle failed payments gracefully.

## 🛠️ Prerequisites

- **Vercel Account**: [Sign up](https://vercel.com)
- **Supabase Project**: [Create new project](https://supabase.com)
- **Stripe Account**: [Sign up](https://stripe.com)

## 📦 Quick Start

### 1. Database Setup (Supabase)

Go to your Supabase SQL Editor and run this query to create the users table:

```sql
create table users (
  id uuid default uuid_generate_v4() primary key,
  email text unique not null,
  stripe_customer_id text,
  subscription_id text,
  plan text,
  status text,
  current_period_end timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 2. Deploy to Vercel

Click the **Deploy** button above or manually deploy:

1.  Import this repo to Vercel.
2.  Add the following Environment Variables:

    ```env
    STRIPE_SECRET_KEY=sk_live_...
    STRIPE_PRICE_ID=price_...
    STRIPE_WEBHOOK_SECRET=whsec_... (Get this after Step 3)
    SUPABASE_URL=https://your-project.supabase.co
    SUPABASE_KEY=your-anon-key
    GPT_API_KEY=create-a-secure-password
    ```

### 3. Configure Stripe Webhook

1.  Go to **Stripe Dashboard > Developers > Webhooks**.
2.  Add Endpoint: `https://your-vercel-app.vercel.app/api/stripe/webhook`
3.  Select events:
    - `checkout.session.completed`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `invoice.payment_succeeded`
4.  Copy the **Signing Secret** and update `STRIPE_WEBHOOK_SECRET` in Vercel.

## 🧪 Testing & Showcase


### OpenAPI Specification
The `openapi-v2.yaml` file is ready for your GPT Action.
1.  Copy the content of `openapi-v2.yaml`.
2.  Paste it into your GPT configuration.
3.  Update the `servers.url` to your Vercel URL.

## 🔌 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/check-access` | Check if a user has active subscription |
| `POST` | `/api/stripe/create-checkout-session` | Create payment link |
| `POST` | `/api/stripe/create-portal-session` | Manage subscription |
| `POST` | `/api/stripe/resend-invoice` | Resend unpaid invoice |
| `GET` | `/api/user/:email` | Get user details |

## 🔐 Security

- **API Key**: All endpoints (except webhooks) require `X-API-Key` header.
- **RLS**: Enable Row Level Security in Supabase for extra protection.

## 📝 Local Development

1.  Clone repo.
2.  `npm install`
3.  Create `.env` file.
4.  `npm start` (Runs on port 3000)
