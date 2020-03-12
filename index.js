// TODO: use the readiness endpoint. If api is down, start backup server.

// https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/node-reusing-connections.html
process.env.AWS_NODEJS_CONNECTION_REUSE_ENABLED = '1';

const Influx = require('influx')
const runInterval = parseInt(process.env.RUN_INTERVAL_MS) || 300000;

// Load the AWS SDK for Node.js
const AWS = require('aws-sdk');
// Set the region 
AWS.config.update({region: process.env.AWS_REGION});

AWS.config.getCredentials(function(err) {
  if (err) console.log(err.stack);
  // credentials not loaded
  else {
    console.log("AWS credentials are setup correctly");
    console.log("Access key:", AWS.config.credentials.accessKeyId.slice(0, 8) + '...');
    console.log("Secret access key:", AWS.config.credentials.secretAccessKey.slice(0, 8) + '...');
  }
});

console.log("Run interval: ~" + Math.round(runInterval / 1000 / 60) + " minutes.")

function run() {

  console.log(new Date());

  const host =  process.env.INFLUX_HOST || 'localhost';
  const database = process.env.INFLUX_DATABASE || 'telegraf';
  const telegrafHostPrefix = process.env.TELEGRAF_HOST_PREFIX || '';
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
    'WHERE ("host" =~ /^' + telegrafHostPrefix + masterHost + '$/) ' +
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
    console.log('load:', max);
    if (max.mean > 0.2) {
      return startBackup('master is busy');
    }

    stopBackup();
  }

  function maxMean(a, b) { return a.mean > b.mean ? a : b; }

  function startBackup(reason) {
    console.log('++ starting backup server: ' + reason);
    manageBackup('START');
  }

  function stopBackup() {
    console.log('-- stopping backup server: everything is in order');
    manageBackup('STOP');
  }

  // Code from: 
  // https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/ec2-example-managing-instances.html
  function manageBackup(command) {
    // Create EC2 service object
    const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});
    const params = {
      InstanceIds: [backupHost],
      DryRun: true
    };
		if (command === "START") {
			// Call EC2 to start the selected instances
			ec2.startInstances(params, function(err, data) {
				if (err && err.code === 'DryRunOperation') {
					params.DryRun = false;
					ec2.startInstances(params, function(err, data) {
							if (err) {
								console.log("Error", err);
							} else if (data) {
								console.log("Success", data.StartingInstances);
							}
					});
				} else {
					console.log("You don't have permission to start instances.");
				}
			});
		} else if (command === "STOP") {
			// Call EC2 to stop the selected instances
			ec2.stopInstances(params, function(err, data) {
				if (err && err.code === 'DryRunOperation') {
					params.DryRun = false;
					ec2.stopInstances(params, function(err, data) {
							if (err) {
								console.log("Error", err);
							} else if (data) {
								console.log("Success", data.StoppingInstances);
							}
					});
				} else {
					console.log("You don't have permission to stop instances");
				}
			});
		}
    else {
      console.log("Unknown command: " + command);
    }
  }
}

// run now and every interval.
run();
setInterval(run, runInterval);

