const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    ios: {
      minVersion: process.env.MIN_VERSION_IOS || '2.0.0',
      store_url: 'https://apps.apple.com/us/app/troystack-gold-silver-ai/id6757343766',
    },
    android: {
      minVersion: process.env.MIN_VERSION_ANDROID || '2.0.0',
      store_url: '',
    },
    message: process.env.MIN_VERSION_MESSAGE || 'A new version of TroyStack is available. Please update to continue.',
    enforced: process.env.MIN_VERSION_ENFORCED === 'true',
  });
});

module.exports = router;
