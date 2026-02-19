const express = require('express');
const router = express.Router();

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - Stack Tracker Gold</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
    }
    h1 {
      font-size: 2.5em;
      color: #111827;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .tagline {
      font-size: 1.2em;
      color: #6b7280;
      margin-bottom: 30px;
      font-weight: 500;
    }
    .last-updated {
      color: #9ca3af;
      font-size: 0.9em;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e5e7eb;
    }
    h2 {
      font-size: 1.8em;
      color: #374151;
      margin-top: 30px;
      margin-bottom: 15px;
      font-weight: 600;
    }
    .principle {
      background: #f9fafb;
      border-left: 4px solid #fbbf24;
      padding: 20px;
      margin-bottom: 20px;
      border-radius: 6px;
    }
    .principle h3 {
      color: #111827;
      font-size: 1.3em;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .principle p {
      color: #4b5563;
      line-height: 1.7;
      font-size: 1.05em;
    }
    .icon {
      font-size: 1.5em;
    }
    .summary {
      background: #fef3c7;
      border: 2px solid #fbbf24;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
      font-size: 1.1em;
      color: #78350f;
      font-weight: 500;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 2px solid #e5e7eb;
      color: #6b7280;
      text-align: center;
      font-size: 0.95em;
    }
    a {
      color: #667eea;
      text-decoration: none;
      font-weight: 600;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>&#x1FA99; Privacy Policy</h1>
    <p class="tagline">Stack Tracker Gold - Privacy-First Precious Metals Portfolio</p>
    <p class="last-updated">Last Updated: February 17, 2026</p>

    <div class="summary">
      <strong>TL;DR:</strong> Your portfolio data is stored on your device by default. If you create an account, your data is encrypted and stored securely in Supabase (our cloud database) for cross-device sync. AI features send portfolio data to Google Gemini for analysis &mdash; this data is not shared beyond the AI provider. We never sell or share your data with advertisers. Receipt images are deleted immediately after processing.
    </div>

    <h2>Our Privacy Principles</h2>

    <div class="principle">
      <h3><span class="icon">&#x1F4F1;</span> Local-First Data Storage</h3>
      <p>
        By default, all your portfolio data&mdash;your precious metals holdings, purchase history, and preferences&mdash;is stored on your device using encrypted local storage. You can use Stack Tracker Gold without an account, and your data stays entirely on your device.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x2601;&#xFE0F;</span> Optional Cloud Sync</h3>
      <p>
        Gold and Lifetime subscribers can optionally create an account and enable cloud sync. When enabled, your portfolio data is encrypted and stored on our secure servers to sync across your devices. Cloud sync is entirely optional&mdash;you can use all features without it. You can delete your cloud account and all associated data at any time from the app settings.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F916;</span> AI-Generated Content</h3>
      <p>
        Features like <strong>Daily Brief</strong> and <strong>Portfolio Intelligence</strong> use AI to generate market analysis and portfolio insights. To provide these features, your portfolio data (holdings, values, and metal allocations) is sent to the <strong>Google Gemini API</strong> for analysis. This data is used solely for generating your personalized insights and is <strong>not shared with third parties beyond the AI provider</strong> for analysis purposes. AI-generated content is for informational purposes only and does not constitute financial advice.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F514;</span> Push Notifications</h3>
      <p>
        When you enable push notifications, we collect and store your <strong>Expo push token</strong> to deliver notifications to your device. Your notification preferences (Daily Brief, Price Alerts, Breaking News &amp; COMEX alerts) are stored server-side in Supabase and tied to your user account. You can disable any notification type at any time in Settings &rarr; Notifications. We do not use push tokens for advertising or tracking purposes.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F3E6;</span> COMEX Warehouse Data</h3>
      <p>
        The Vault Watch feature displays COMEX warehouse inventory data sourced from CME Group. This is publicly available market data and does not involve any collection or processing of your personal information.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F4F7;</span> Memory-Only Image Processing</h3>
      <p>
        When you use our AI receipt scanning feature, images are processed in memory and <strong>deleted immediately</strong> after analysis. No receipts, photos, or scanned images are ever stored on our servers. Only the extracted text data (item descriptions, prices, quantities) is returned to your device.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F4CA;</span> Portfolio Snapshots</h3>
      <p>
        To power analytics charts and historical tracking, we store daily portfolio value snapshots on our servers. These snapshots contain aggregate values only (total portfolio value, metal totals) and are tied to your anonymous user ID. They do not contain individual item details.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F6AB;</span> No Analytics or Tracking</h3>
      <p>
        We do not use Google Analytics, Facebook SDK, advertising networks, or any third-party tracking tools. We don't collect usage data, device fingerprints, or behavioral analytics. Your activity in the app is completely private.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F511;</span> No Account Required</h3>
      <p>
        You can use Stack Tracker Gold fully without creating an account (Guest Mode). No email, no password, no personal information required. Your data stays on your device, under your control. Accounts are only needed for optional cloud sync.
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F4B0;</span> Third-Party Services</h3>
      <p>
        We use the following third-party services to power the app:
      </p>
      <p>
        <strong>MetalPriceAPI</strong> &amp; <strong>GoldAPI.io</strong> &mdash; Live spot prices. These requests contain no personal data.<br>
        <strong>RevenueCat</strong> &mdash; Subscription management. Receives an anonymous user ID only.<br>
        <strong>Supabase</strong> &mdash; Cloud database for account sync and portfolio snapshots. Data is stored securely with row-level security.<br>
        <strong>Expo</strong> &mdash; Push notifications for price alerts. Receives only a device push token.<br>
        <strong>Apple App Store</strong> &mdash; Payment processing. We never see your payment details.
      </p>
    </div>

    <h2>Data We Collect</h2>
    <div class="principle">
      <h3><span class="icon">&#x1F4CB;</span> What We Store</h3>
      <p>
        &#x2705; Anonymous user ID (for subscription and sync features)<br>
        &#x2705; Portfolio snapshots for analytics (aggregate values only)<br>
        &#x2705; Cloud sync data if you opt in (encrypted portfolio data)<br>
        &#x2705; Price alert preferences (target prices and notification settings)<br>
        &#x2705; Expo push token (for delivering push notifications to your device)<br>
        &#x2705; Notification preferences (which alerts you've enabled/disabled)<br>
        &#x2705; AI-processed portfolio summaries (sent to Google Gemini for analysis, not stored permanently)
      </p>
    </div>

    <div class="principle">
      <h3><span class="icon">&#x1F6AB;</span> What We Never Collect</h3>
      <p>
        &#x274C; Receipt images or scanned documents (deleted immediately)<br>
        &#x274C; Personal information (name, address, phone number)<br>
        &#x274C; Location data or device identifiers<br>
        &#x274C; Usage analytics or behavioral tracking<br>
        &#x274C; Payment details (handled by Apple/Google)
      </p>
    </div>

    <h2>Data Sharing</h2>
    <div class="principle">
      <h3><span class="icon">&#x1F512;</span> We Never Sell Your Data</h3>
      <p>
        Your data is never sold, shared with advertisers, or provided to third parties for marketing purposes. Data is only shared with service providers essential to app functionality (payment processing, price data APIs) and only the minimum data necessary.
      </p>
    </div>

    <h2>Your Rights</h2>
    <div class="principle">
      <h3><span class="icon">&#x1F6E1;&#xFE0F;</span> Complete Control</h3>
      <p>
        You can export your data anytime as CSV. If you have a cloud account, you can delete your account and all server-side data from Settings &rarr; Danger Zone. Guest mode users have all data stored locally&mdash;simply deleting the app removes all data. You can also reset all data from within the app settings.
      </p>
    </div>

    <h2>Changes to This Policy</h2>
    <p style="margin-top: 20px; color: #4b5563; line-height: 1.7;">
      If we make changes to this privacy policy, we'll update the "Last Updated" date at the top. Significant changes will be communicated through the app.
    </p>

    <div class="footer">
      <p>Questions about privacy? Contact us at <a href="mailto:stacktrackergold@gmail.com">stacktrackergold@gmail.com</a></p>
      <p style="margin-top: 10px;">Built with privacy in mind. Your data, your control. &#x1F512;</p>
    </div>
  </div>
</body>
</html>`;

const TERMS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Use - Stack Tracker Gold</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
    }
    h1 {
      font-size: 2.5em;
      color: #111827;
      margin-bottom: 10px;
      font-weight: 700;
    }
    .tagline {
      font-size: 1.2em;
      color: #6b7280;
      margin-bottom: 30px;
      font-weight: 500;
    }
    .last-updated {
      color: #9ca3af;
      font-size: 0.9em;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e5e7eb;
    }
    h2 {
      font-size: 1.5em;
      color: #374151;
      margin-top: 30px;
      margin-bottom: 15px;
      font-weight: 600;
    }
    p, ul {
      color: #4b5563;
      margin-bottom: 15px;
      line-height: 1.7;
    }
    ul {
      margin-left: 20px;
    }
    li {
      margin-bottom: 8px;
    }
    .summary {
      background: #fef3c7;
      border: 2px solid #fbbf24;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 30px;
      font-size: 1.1em;
      color: #78350f;
      font-weight: 500;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 2px solid #e5e7eb;
      color: #6b7280;
      text-align: center;
      font-size: 0.95em;
    }
    a {
      color: #667eea;
      text-decoration: none;
      font-weight: 600;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>&#x1F4DC; Terms of Use</h1>
    <p class="tagline">Stack Tracker Gold - Privacy-First Precious Metals Portfolio</p>
    <p class="last-updated">Last Updated: February 17, 2026</p>

    <div class="summary">
      By using Stack Tracker Gold, you agree to these terms. Please read them carefully.
    </div>

    <h2>1. Acceptance of Terms</h2>
    <p>
      By downloading, installing, or using Stack Tracker Gold ("the App"), you agree to be bound by these Terms of Use. If you do not agree to these terms, please do not use the App.
    </p>

    <h2>2. Description of Service</h2>
    <p>
      Stack Tracker Gold is a personal portfolio tracking application for precious metals enthusiasts. The App allows you to:
    </p>
    <ul>
      <li>Track your gold, silver, platinum, and palladium holdings</li>
      <li>Scan receipts using AI-powered image recognition</li>
      <li>View live spot prices for precious metals</li>
      <li>View COMEX warehouse inventory data (Vault Watch)</li>
      <li>Receive AI-generated market analysis and portfolio insights</li>
      <li>Receive push notifications for price alerts, daily briefs, and breaking news</li>
      <li>Export your portfolio data in various formats</li>
    </ul>

    <h2>3. User Responsibilities</h2>
    <p>You agree to:</p>
    <ul>
      <li>Use the App only for lawful purposes</li>
      <li>Verify the accuracy of all portfolio data, including AI-scanned receipt results &mdash; you are solely responsible for ensuring your holdings data is correct</li>
      <li>Not attempt to reverse engineer, modify, or exploit the App</li>
      <li>Not use the App to store or process illegal content</li>
      <li>Maintain the security of your device and account credentials</li>
    </ul>

    <h2>4. Data and Privacy</h2>
    <p>
      Your portfolio data is stored locally on your device by default. If you create an account and enable cloud sync, your data is encrypted and stored on our servers. Receipt images are deleted immediately after AI processing. For full details, please review our <a href="/privacy">Privacy Policy</a>.
    </p>

    <h2>5. AI-Generated Content</h2>
    <p>
      The App includes features powered by artificial intelligence, including Daily Brief, Portfolio Intelligence, and Market Intelligence. By using these features, you acknowledge and agree that:
    </p>
    <ul>
      <li><strong>Not financial advice:</strong> All AI-generated content is for informational and educational purposes only. It does not constitute financial advice, investment recommendations, or any form of professional guidance.</li>
      <li><strong>No guarantee of accuracy:</strong> AI-generated analysis, summaries, and insights may contain errors, inaccuracies, or outdated information. You should not rely solely on AI content for investment decisions.</li>
      <li><strong>Data processing:</strong> To generate personalized insights, your portfolio data (holdings, values, allocations) is sent to third-party AI providers (Google Gemini) for processing. This data is used solely for generating your insights and is not shared beyond the AI provider.</li>
      <li><strong>Your responsibility:</strong> You are solely responsible for any investment or financial decisions you make. Always consult qualified financial professionals before making significant financial decisions.</li>
    </ul>

    <h2>6. Push Notifications</h2>
    <p>
      The App offers optional push notifications for price alerts, daily market briefs, and breaking news. By enabling notifications, you agree that:
    </p>
    <ul>
      <li>Your device push token will be stored on our servers to deliver notifications</li>
      <li>Your notification preferences are stored server-side and tied to your account</li>
      <li>Notification content (price alerts, market summaries) may be delayed or inaccurate due to network conditions or data source delays</li>
      <li>You can disable any or all notification types at any time in Settings</li>
      <li>We will not use push notifications for advertising or promotional purposes unrelated to the App</li>
    </ul>

    <h2>7. Subscriptions and Payments</h2>
    <p>
      Stack Tracker Gold offers a free tier and premium "Gold" subscriptions with the following pricing:
    </p>
    <ul>
      <li><strong>Gold Monthly:</strong> $9.99/month &mdash; auto-renews monthly</li>
      <li><strong>Gold Yearly:</strong> $79.99/year &mdash; auto-renews annually</li>
      <li><strong>Lifetime:</strong> $199.99 &mdash; one-time purchase, never expires</li>
    </ul>
    <p>
      All subscriptions are processed through the Apple App Store. Subscription terms:
    </p>
    <ul>
      <li>Subscriptions automatically renew unless cancelled at least 24 hours before the end of the current period</li>
      <li>Your Apple ID account will be charged for renewal within 24 hours prior to the end of the current period</li>
      <li>You can manage and cancel subscriptions in your device's Settings &rarr; Apple ID &rarr; Subscriptions</li>
      <li>Refunds are handled according to Apple App Store policies</li>
      <li>Free trial periods, if offered, will automatically convert to a paid subscription unless cancelled</li>
    </ul>

    <h2>8. Data Accuracy Disclaimer</h2>
    <p>
      The App displays data from multiple third-party sources. You acknowledge and agree that:
    </p>
    <ul>
      <li><strong>Spot prices</strong> are sourced from third-party APIs (MetalPriceAPI, GoldAPI) and may be delayed, inaccurate, or temporarily unavailable</li>
      <li><strong>COMEX warehouse data</strong> is sourced from CME Group and may not reflect real-time inventory changes</li>
      <li><strong>AI-generated analysis</strong> (Daily Brief, Portfolio Intelligence, Market Intelligence) may contain errors and should not be relied upon as the sole basis for any decision</li>
      <li><strong>Receipt scanning</strong> uses AI vision which may misread digits, prices, or quantities &mdash; always verify scanned data before saving</li>
      <li><strong>Portfolio valuations</strong> are estimates based on available spot price data and may not reflect the actual market or resale value of your holdings</li>
    </ul>

    <h2>9. Disclaimer of Warranties</h2>
    <p>
      The App is provided <strong>"as is" and "as available"</strong> without warranties of any kind, whether express or implied. We do not guarantee the accuracy, completeness, or timeliness of any data, content, or features provided by the App.
    </p>
    <p>
      <strong>Stack Tracker Gold is not a financial advisor, broker, or dealer.</strong> The App is for personal informational and tracking purposes only. It does not provide investment advice, tax guidance, or financial recommendations. Always verify important financial information independently and consult qualified professionals for financial decisions.
    </p>

    <h2>10. Limitation of Liability</h2>
    <p>
      To the maximum extent permitted by law, Stack Tracker Gold and its developers shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the App, including but not limited to losses arising from reliance on AI-generated content, inaccurate spot prices, or data synchronization issues.
    </p>

    <h2>11. Intellectual Property</h2>
    <p>
      All content, features, and functionality of the App are owned by Stack Tracker Gold and are protected by copyright, trademark, and other intellectual property laws.
    </p>

    <h2>12. Changes to Terms</h2>
    <p>
      We may update these Terms of Use from time to time. Continued use of the App after changes constitutes acceptance of the new terms. We will update the "Last Updated" date when changes are made.
    </p>

    <h2>13. Termination</h2>
    <p>
      We reserve the right to terminate or suspend access to the App at any time, without prior notice, for conduct that we believe violates these terms or is harmful to other users or the App.
    </p>

    <h2>14. Contact Us</h2>
    <p>
      If you have questions about these Terms of Use, please contact us at <a href="mailto:stacktrackergold@gmail.com">stacktrackergold@gmail.com</a>.
    </p>

    <div class="footer">
      <p>Questions? Contact us at <a href="mailto:stacktrackergold@gmail.com">stacktrackergold@gmail.com</a></p>
      <p style="margin-top: 10px;">Stack Tracker Gold - Track your stack with confidence. &#x1FA99;</p>
    </div>
  </div>
</body>
</html>`;

router.get('/privacy', (req, res) => {
  res.type('html').send(PRIVACY_HTML);
});

router.get('/terms', (req, res) => {
  res.type('html').send(TERMS_HTML);
});

module.exports = router;
