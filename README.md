# Key Store Panel — Render test starter

## Included
- Customer registration/login
- Customer dashboard in dark/neon style
- Product → multiple plans
- Customer/reseller pricing
- Special-price database support
- One key per line bulk key import
- Wallet balance
- Manual UPI deposit request with UTR + screenshot
- Admin deposit approval/rejection
- Automatic wallet credit after approval
- Purchase deducts wallet and assigns one available key
- My Keys
- Admin product/key management

## Render
Create a PostgreSQL database and a Web Service from this repository.
Build command: `npm install`
Start command: `npm start`

Environment variables:
- `DATABASE_URL` = Render PostgreSQL internal/external connection string
- `JWT_SECRET` = long random secret

The app auto-creates its tables on first start.

Default test admin:
Email: `admin@example.com`
Password: `Admin@12345`

CHANGE THE ADMIN PASSWORD / CREDENTIALS BEFORE REAL USE.

## Important
Google login and real email OTP are UI placeholders in this starter. Do not pretend an OTP was sent or enable production authentication until a real OAuth/email provider is configured and verified.

For real payments, use a proper payment provider with server-side webhook/signature verification. Do not credit wallets from a client-side success message alone.
