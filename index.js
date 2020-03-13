var influxHost = process.env.INFLUX_HOST || 'localhost';
var influxDatabase = process.env.INFLUX_DATABASE || 'telegraf';
var telegrafHostPrefix = process.env.TELEGRAF_HOST_PREFIX || '';
var loadThreshold = parseFloat(process.env.LOAD_THRESHOLD) || 0.2;
var ec2TagKey = process.env.EC2_TAG_KEY || 'Name';
var ec2TagValue = requiredEnv('EC2_TAG_VALUE');
var cloudflareAuthEmail = requiredEnv('CLOUDFLARE_AUTH_EMAIL');
var cloudflareAuthKey = requiredEnv('CLOUDFLARE_AUTH_KEY');
var cloudflareAccountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
var cloudflarePoolId = requiredEnv('CLOUDFLARE_POOL_ID');
var runInterval = parseInt(process.env.RUN_INTERVAL_MS) || 300000;
var awsRegion = process.env.AWS_REGION;

function requiredEnv(envName) {
  var ret = process.env[envName];
  if (!ret) {
    console.error("ERROR: Environment variable \"" + envName + "\" not set.");
    process.exit(1);
  }
  return ret;
}

// https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/node-reusing-connections.html
process.env.AWS_NODEJS_CONNECTION_REUSE_ENABLED = '1';

var https = require('https');
var Influx = require('influx');
var AWS = require('aws-sdk');
AWS.config.update({ region: awsRegion });

AWS.config.getCredentials(function (err) {
  if (err)
    console.log(err.stack);
  else {
    console.log("> AWS credentials are setup correctly");
    console.log("  Access key:       ", AWS.config.credentials.accessKeyId.slice(0, 8) + '...');
    console.log("  Secret access key:", AWS.config.credentials.secretAccessKey.slice(0, 8) + '...');
  }
});

function run() {
  console.log('===', new Date(), '===');

  function describeInstances(callback) {
    var ec2 = new AWS.EC2({ apiVersion: '2016-11-15' });
    var params = {
      Filters: [{
        Name: "tag:" + ec2TagKey,
        Values: [ec2TagValue]
      }]
    };
    ec2.describeInstances(params, function (err, data) {
      if (err) {
        callback(err);
      }
      else {
        // console.log(data);           // successful response
        var instances = {};
        data.Reservations.forEach(function (reservation) {
          reservation.Instances.forEach(function (instance) {
            // cf https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#describeInstances-property
            // for list of available fields
            instances[instance.InstanceId] = {
              instanceId: instance.InstanceId,
              publicIpAddress: instance.PublicIpAddress,
              state: instance.State.Name
            };
          });
        });
        callback(null, Object.values(instances));
      }
    });
  }

  function selectMaster(instances) {
    return instances
      .filter(function (a) {
        return a.publicIpAddress;
      })
      .sort(function (a, b) {
        return a.instanceId > b.instanceId ? 1 : -1;
      })[0];
  }

  function selectBackup(instances) {
    var master = selectMaster(instances);
    return instances
      .filter(function (a) {
        return a.instanceId != master.instanceId;
      })[0];
  }

  describeInstances(function (err, instances) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    }
    else {
      autoScale(selectMaster(instances), selectBackup(instances));
      updateCloudflarePool(instances);
    }
  });

  function loadCloudflarePool(callback) {
    const options = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path: "/client/v4/accounts/" + cloudflareAccountId + "/load_balancers/pools/" + cloudflarePoolId,
      method: 'GET',
      headers: {
        'X-Auth-Key': cloudflareAuthKey,
        'X-Auth-Email': cloudflareAuthEmail,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, function (res) {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const json = JSON.parse(body);
        if (!json.success && !json.result)
          return;
        callback(json.result);
      });
    });
    req.end();
  }

  function updateCloudflarePool(instances) {
    loadCloudflarePool(pool => {
      const ips = instances.map(function (i) { return i.publicIpAddress; }).filter(function (i) { return i; });
      const options = {
        hostname: 'api.cloudflare.com',
        port: 443,
        path: "/client/v4/accounts/" + cloudflareAccountId + "/load_balancers/pools/" + cloudflarePoolId,
        method: 'PUT',
        headers: {
          'X-Auth-Key': cloudflareAuthKey,
          'X-Auth-Email': cloudflareAuthEmail,
          'Content-Type': 'application/json'
        }
      };
      const body = {
        name: pool.name,
        description: pool.description,
        notification_email: pool.notification_email,
        monitor: pool.monitor,
        origins: instances.filter(function (i) { return i.publicIpAddress; }).map(function (i) { return ({
          name: i.instanceId,
          address: i.publicIpAddress,
          enabled: true
        }); })
      };
      const req = https.request(options, function (res) {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const json = JSON.parse(data);
          if (!json.success) {
            console.log(data);
          }
        });
      });
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  function autoScale(master, backup) {

    if (master.state !== 'running' && backup.state !== 'running') {
      return startBackup('master is ' + master.state);
    }

    if (backup.state === 'pending' || backup.state === 'stopping') {
      // No actions while previous command still in progress.
      console.log('backup is ' + backup.state);
      return;
    }

    var influx = new Influx.InfluxDB({
      host: influxHost,
      database: influxDatabase,
      schema: []
    });

    var now = Math.floor(+new Date());
    var fromTime = now - 1800000; // half an hour ago
    var toTime = now - 300000; // five minutes ago
    var totalTime = toTime - fromTime;
    var numSplits = 3;

    var query = 'SELECT mean("load5") ' +
      'FROM "autogen"."system" ' +
      'WHERE ("host" =~ /^' + telegrafHostPrefix + master.instanceId + '$/) ' +
      'AND time >= ' + fromTime + 'ms ' +
      'AND time <= ' + toTime + 'ms ' +
      'GROUP BY time(' + Math.round(totalTime / numSplits) + 'ms) fill(none)';

    influx.query(query)
      .then(processResult)
      .catch(function (err) {
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
      var max = result.reduce(maxMean, result[0]);
      console.log('load:', max.mean);
      if (max.mean > loadThreshold) {
        return startBackup('master is busy (load=' + max.mean + ')');
      }
      stopBackup();
    }

    function startBackup(reason) {
      if (backup.state === 'running' || backup.state === 'pending')
        return;
      console.log('++ starting backup server: ' + reason);
      manageInstance(backup, 'START');
    }

    function stopBackup() {
      if (backup.state === 'stopped' || backup.state === 'stopping')
        return;
      console.log('-- stopping backup server: everything is in order');
      manageInstance(backup, 'STOP');
    }
  }

  function maxMean(a, b) { return a.mean > b.mean ? a : b; }

  // Code from: 
  // https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/ec2-example-managing-instances.html
  function manageInstance(instance, command) {
    // Create EC2 service object
    var ec2 = new AWS.EC2({ apiVersion: '2016-11-15' });
    var params = {
      InstanceIds: [instance.instanceId],
      DryRun: true
    };
    if (command === "START") {
      // Call EC2 to start the selected instances
      ec2.startInstances(params, function (err, data) {
        if (err && err.code === 'DryRunOperation') {
          params.DryRun = false;
          ec2.startInstances(params, function (err, data) {
            if (err) {
              console.log("Error", err);
            }
            else if (data) {
              console.log("Success", data.StartingInstances);
            }
          });
        }
        else {
          console.log("You don't have permission to start instances.");
        }
      });
    }
    else if (command === "STOP") {
      // Call EC2 to stop the selected instances
      ec2.stopInstances(params, function (err, data) {
        if (err && err.code === 'DryRunOperation') {
          params.DryRun = false;
          ec2.stopInstances(params, function (err, data) {
            if (err) {
              console.log("Error", err);
            }
            else if (data) {
              console.log("Success", data.StoppingInstances);
            }
          });
        }
        else {
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
console.log("> Run interval: ~" + Math.round(runInterval / 1000 / 60) + " minutes.");
run();
setInterval(run, runInterval);
