const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const PORT = process.env.PORT || 8000;

__path = process.cwd();

require('events').EventEmitter.defaultMaxListeners = 500;

let code = require('./pair');

app.use('/code', code);
app.use('/pair', async (req, res, next) => {
    res.sendFile(__path + '/main.html');
});
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html');
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`\n🚀 AK X MD Bot Server Running on http://localhost:${PORT}\n`);
});

module.exports = app;
