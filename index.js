'use strict';

// TODO: use the readiness endpoint. If api is down, start backup server.

const Influx = require('influx')
const runInterval = parseInt(process.env.RUN_INTERVAL_MS) || 300000;

function run() {

  console.log(new Date());

  const host =  process.env.INFLUX_HOST || 'localhost';
  const database = process.env.INFLUX_DATABASE || 'telegraf';
  const masterHost = process.env.MASTER_HOST_EC2_ID;
  const backupHost = process.env.BACKUP_HOST_EC2_ID;
  const loadThreshold = parseFloat(process.env.LOAD_THRESHOLD) || 0.2;

  const influx = new Influx.InfluxDB({
    host,
    database,
    schema: []
  })

  const now = Math.floor(+new Date());
  const fromTime = now - 1800000; // half an hour ago
  const toTime = now - 300000; // five minutes ago
  const totalTime = toTime - fromTime;
  const numSplits = 3;

  const query =
    'SELECT mean("load5") ' + 
    'FROM "autogen"."system" ' + 
    'WHERE ("host" =~ /^' + masterHost + '$/) ' +
    'AND time >= ' + fromTime + 'ms ' +
    'AND time <= ' + toTime + 'ms ' + 
    'GROUP BY time(' + Math.round(totalTime / numSplits) + 'ms) fill(none)';

  influx.query(query)
    .then(processResult)
    .catch(err => {
      console.error(err);
    });

  function processResult(result) {

    // We expect numSplits (or numSplits + 1) results.
    // If we receive less, it means the host is either down or not reporting to
    // grafana. Let's start the backup server.
    if (result.length < numSplits) {
      return startBackup('master host not reporting');
    }

    // If the largest mean from load5 is above the threshold, we start the backup server.
    const max = result.reduce(maxMean, result[0]);
    if (max.mean > 0.2) {
      return startBackup('master is busy');
    }

    stopBackup();
  }

  function maxMean(a, b) { return a.mean > b.mean ? a.mean : b.mean; }

  function startBackup(reason) {
    console.log('++ starting backup server: ' + reason);
  }

  function stopBackup() {
    console.log('-- stopping backup server: everything is in order');
  }
}

// run now and every interval.
run();
setInterval(run, runInterval);

