const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    ios: {
      minVersion: process.env.MIN_VERSION_IOS || '2.0.0',
      store_url: 'https://apps.apple.com/us/app/stack-tracker-gold/id6738029817',
    },
    android: {
      minVersion: process.env.MIN_VERSION_ANDROID || '2.0.0',
      store_url: '',
    },
    message: process.env.MIN_VERSION_MESSAGE || 'A new version of Stack Tracker Gold is available. Please update to continue.',
    enforced: process.env.MIN_VERSION_ENFORCED === 'true',
  });
});

module.exports = router;
