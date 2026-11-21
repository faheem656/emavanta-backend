# Hostinger Email SMTP setup

These examples are for **Hostinger Email**. If your mailbox is Google Workspace or another product purchased through Hostinger, use the settings shown in hPanel → Emails → Manage → Connect Apps & Devices for that product instead.

Use Node.js 22 or newer with the updated package. Back up your current `.env`. Do not paste your password into a chat or send it to support. In the backend folder’s `.env`, put your actual complete mailbox address and its **mailbox password** (not the password for logging in to hPanel):

```dotenv
SMTP_PROVIDER=hostinger
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=true
SMTP_USER=your-mailbox@your-domain.com
SMTP_PASSWORD=your-mailbox-password
SMTP_FROM=your-mailbox@your-domain.com
```

The Hostinger preset fills in the Hostinger host and sender from SMTP_USER only if those fields are empty. Explicit SMTP_HOST and SMTP_FROM take precedence. The provider's own hPanel settings take precedence if different. If port 465 fails due to network or TLS issues, try Hostinger's alternative:

```dotenv
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
```

The setting `SMTP_REQUIRE_TLS=true` makes port 587 require STARTTLS. Do not disable TLS certificate checks. Restart the complete application after changes. In PowerShell, change to this backend folder and run each command separately, substituting your own recipient:

```powershell
Test-NetConnection smtp.hostinger.com -Port 465
Test-NetConnection smtp.hostinger.com -Port 587
npm run smtp:check -- your-inbox@example.com
```

`TcpTestSucceeded : False` suggests connectivity/firewall/provider blocking; TCP success does not prove SMTP login, sender acceptance or inbox delivery. The SMTP check connects, authenticates and sends a test mail; check inbox and spam. If your application is deployed on a server, run the checks on **that server**, not only on your PC.

`SMTP_CONFIG`: check required values, port and TLS pairing. `EAUTH`: verify the full mailbox address and mailbox password, and account policy. `ECONNECTION`, `ETIMEDOUT`, `ESOCKET` or `EDNS`: check DNS, outbound port, firewall/VPN and host network. `ETLS`: inspect port/security and TLS certificate. `EENVELOPE`/`EREJECTED`: check sender and provider policy. The tool identifies effective configuration sources without printing passwords. Process environment variables and `backend/.env.local` take precedence over `backend/.env`; stop the app and restart it.

For signup, HTTP 424 means email was not accepted by SMTP. The user must wait for the resend countdown after you fix the cause. The database stores the OTP hash, not plaintext; the real code goes only in the email. Do not disable verification or store the OTP in plaintext to bypass delivery problems.

Reference: Hostinger configuration https://support.hostinger.com/en/articles/1575756-how-to-get-email-account-configuration-details-for-hostinger-email and https://support.hostinger.com/en/articles/4768584-how-to-set-up-hostinger-email-on-mozilla-thunderbird-desktop-windows .
