const express = require('express');
const router = express.Router();

router.get('/privacy', (req, res) => {
  res.redirect(301, 'https://troystack.com/privacy');
});

router.get('/terms', (req, res) => {
  res.redirect(301, 'https://troystack.com/terms');
});

module.exports = router;
