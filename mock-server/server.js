const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

const historyPath = path.join(__dirname, 'data', 'history.json');

app.get('/history', (req, res) => {
  fs.readFile(historyPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Failed to read history file', err);
      res.status(500).json({ error: 'Failed to load history data' });
      return;
    }

    try {
      const history = JSON.parse(data);
      res.json(history);
    } catch (parseErr) {
      console.error('Invalid JSON in history file', parseErr);
      res.status(500).json({ error: 'Invalid history data' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Mock server running on port ${PORT}`);
});
