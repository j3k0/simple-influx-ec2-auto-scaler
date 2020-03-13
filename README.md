# simple-influx-ec2-auto-scaler

> A *very* simple auto-scaler for EC2 + InfluxDB + Telegraf


### What does it do?

Auto-scale is a big word: this is for a 2 servers setup:

- 1 _master_ server
- 1 _backup_ server.

The master server is automatically selected, as the first ec2 InstanceId in alphabetical order.

In our setup, all servers are identical and behind a load balancer from cloudflare. Requests will be balanced equally between running servers.


This script will:

- Check current load on the master server
- Start backup server if:
  - master server is not reporting (it might be down)
  - master server load is over a given threshold
- Stop backup server otherwise.
- Update cloudflare loadbalancer pool's origins.


### How does it work?

A NodeJS script will run every 5 minutes (by default).

The load of the server is retrieved from InfluxDB, as gathered by Telegraf's [System Input Plugin](https://github.com/influxdata/telegraf/tree/master/plugins/inputs/system).

AWS SDK is used to update the state of the backup server.


## Getting started

You can run from docker.

1. `cp docker-compose.example.yml docker-compose.yml`
2. Edit docker-compose.yml (see `Configuration` below)
3. Run with `docker-compose up`

Or using NodeJS:

1. Install dependencies: `npm install`
2. Set your environment variables (see `Configuration` below)
3. Start `node index.js`

#### Configuration

The execution is controlled by environment variables.

- `INFLUX_HOST` - Address of the influxdb instance
- `INFLUX_DATABASE` - Name of the telegraf database (default: telegraf)
- `RUN_INTERVAL_MS` - Interval in milliseconds between runs (default: 300000)
- `LOAD_THRESHOLD` - Threshold that triggers starting the backup (default: 0.2)
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret access key
- `AWS_REGION` - AWS region where the backup server is running
- `EC2_TAG_KEY` - EC2 hosts have the following tag (default: Name)
- `EC2_TAG_VALUE` - Expected value for the tag filter
- `TELEGRAF_HOST_PREFIX` - Prefix appended to telegraf hostnames
  - hostnames are expected to be `<prefix><ec2_id>`
- `CLOUDFLARE_AUTH_EMAIL` - Cloudflare API authentication email
- `CLOUDFLARE_AUTH_KEY` - Cloudflare API authentication key
- `CLOUDFLARE_ACCOUNT_ID` - Your account ID
  - Retrieve with `curl -H "X-Auth-Key: $CLOUDFLARE_AUTH_KEY" -H "X-Auth-Email: $CLOUDFLARE_AUTH_EMAIL" https://api.cloudflare.com/client/v4/accounts`
- `CLOUDFLARE_POOL_ID` - The pool ID to update
  - Retrieve with `curl -H "X-Auth-Key: $CLOUDFLARE_AUTH_KEY" -H "X-Auth-Email: $CLOUDFLARE_AUTH_EMAIL" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/load_balancers/pools"`
