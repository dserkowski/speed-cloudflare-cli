#!/usr/bin/env node

const { performance } = require('perf_hooks');
const https = require('https');
const { magenta, bold, red, yellow, green, blue } = require('./chalk.js');
const stats = require('./stats.js');

async function get(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'GET',
      },
      (res) => {
        const body = [];
        res.on('data', (chunk) => {
          body.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(Buffer.concat(body).toString());
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', (err) => {
          reject(err);
        });
      }
    );

    req.end();
  });
}

async function fetchServerLocationData() {
  const res = JSON.parse(await get('speed.cloudflare.com', '/locations'));

  return res.reduce((data, { iata, city }) => {
    // Bypass prettier "no-assign-param" rules
    const data1 = data;

    data1[iata] = city;
    return data1;
  }, {});
}

function fetchCfCdnCgiTrace() {
  const parseCfCdnCgiTrace = (text) =>
    text
      .split('\n')
      .map((i) => {
        const j = i.split('=');

        return [j[0], j[1]];
      })
      .reduce((data, [k, v]) => {
        if (v === undefined) return data;

        // Bypass prettier "no-assign-param" rules
        const data1 = data;
        // Object.fromEntries is only supported by Node.js 12 or newer
        data1[k] = v;

        return data1;
      }, {});

  return get('speed.cloudflare.com', '/cdn-cgi/trace').then(parseCfCdnCgiTrace);
}

function request(options, data = '') {
  let started;
  let dnsLookup;
  let tcpHandshake;
  let sslHandshake;
  let ttfb;
  let ended;

  return new Promise((resolve, reject) => {
    started = performance.now();
    const req = https.request(options, (res) => {
      res.once('readable', () => {
        ttfb = performance.now();
      });
      res.on('data', () => {});
      res.on('end', () => {
        ended = performance.now();
        resolve([
          started,
          dnsLookup,
          tcpHandshake,
          sslHandshake,
          ttfb,
          ended,
          parseFloat(res.headers['server-timing'].slice(22)),
        ]);
      });
    });

    req.on('socket', (socket) => {
      socket.on('lookup', () => {
        dnsLookup = performance.now();
      });
      socket.on('connect', () => {
        tcpHandshake = performance.now();
      });
      socket.on('secureConnect', () => {
        sslHandshake = performance.now();
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

function download(bytes) {
  const options = {
    hostname: 'speed.cloudflare.com',
    path: `/__down?bytes=${bytes}`,
    method: 'GET',
  };

  return request(options);
}

function upload(bytes) {
  const data = '0'.repeat(bytes);
  const options = {
    hostname: 'speed.cloudflare.com',
    path: '/__up',
    method: 'POST',
    headers: {
      'Content-Length': Buffer.byteLength(data),
    },
  };

  return request(options, data);
}

function measureSpeed(bytes, duration) {
  return (bytes * 8) / (duration / 1000) / 1e6;
}

async function measureLatency() {
  const measurements = [];

  for (let i = 0; i < 100; i += 1) {
    await download(200).then(
      (response) => {
        // TTFB - Server processing time
        measurements.push(response[4] - response[0] - response[6]);
      },
      (error) => {
        console.log(`Error: ${error}`);
      }
    );
  }

  return [
    Math.min(...measurements),
    Math.max(...measurements),
    stats.average(measurements),
    stats.median(measurements),
    stats.jitter(measurements),
    stats.jitterP95(measurements),
    stats.jitterP99(measurements),
    stats.p95(measurements),
    stats.p99(measurements),
  ];
}

async function measureDownload(bytes, iterations) {
  const measurements = [];

  for (let i = 0; i < iterations; i += 1) {
    await download(bytes).then(
      (response) => {
        const transferTime = response[5] - response[4];
        measurements.push(measureSpeed(bytes, transferTime));
      },
      (error) => {
        console.log(`Error: ${error}`);
      }
    );
  }

  return measurements;
}

async function measureUpload(bytes, iterations) {
  const measurements = [];

  for (let i = 0; i < iterations; i += 1) {
    await upload(bytes).then(
      (response) => {
        const transferTime = response[6];
        measurements.push(measureSpeed(bytes, transferTime));
      },
      (error) => {
        console.log(`Error: ${error}`);
      }
    );
  }

  return measurements;
}

function logInfo(text, data) {
  console.log(' '.repeat(15 - text.length), `${text}:`, blue(data));
}

function formatResult(value, unitName, warnThreshold, lowerBetter) {
  const cmpResult = lowerBetter ? (value > warnThreshold) : (value < warnThreshold);
  if (cmpResult) {
    return bold(red(`${value.toFixed(2)} ${unitName} (WARN)`))
  } else {
    return green(`${value.toFixed(2)} ${unitName}`)
  }
}

function formatLatency(value, warnThreshold) {
  return formatResult(value, 'ms', warnThreshold, true)
}

function formatSpeed(value, warnThreshold) {
  return formatResult(value, 'Mbps', warnThreshold, false)
}

function logLatency(data) {
  console.log('   Latency (avg):', formatLatency(data[3], 65.0));
  console.log('   Latency (p99):', formatLatency(data[8], 85.0));
  // console.log(bold('         Latency (p95):', magenta(`${data[7].toFixed(2)} ms`)));
  
  console.log('    Jitter (avg):', formatLatency(data[4], 10.0));
  console.log('    Jitter (p99):', formatLatency(data[6], 15.0));
  // console.log(bold('          Jitter (p95):', magenta(`${data[5].toFixed(2)} ms`)));
}

function logSpeedTestResult(size, test) {
  const speed = stats.median(test).toFixed(2);
  console.log(
    bold(' '.repeat(9 - size.length), size, 'speed:', yellow(`${speed} Mbps`))
  );
}

function logDownloadSpeed(tests) {
  console.log(
      '  Download speed:',
      formatSpeed(stats.quartile(tests, 0.9), 3.0)
  );
}

function logUploadSpeed(tests) {
  console.log(
      '    Upload speed:',
      formatSpeed(stats.quartile(tests, 0.9), 1.0)
  );
}

async function speedTest() {
  const [ping, serverLocationData, { ip, loc, colo }] = await Promise.all([
    measureLatency(),
    fetchServerLocationData(),
    fetchCfCdnCgiTrace(),
  ]);

  const city = serverLocationData[colo];
  logInfo('Server location', `${city} (${colo})`);
  logInfo('Your IP', `${ip} (${loc})`);

  logLatency(ping);

  const testDown1 = await measureDownload(101000, 2);
  //logSpeedTestResult('100kB', testDown1);

  //const testDown2 = await measureDownload(1001000, 8);
  //logSpeedTestResult('1MB', testDown2);

  //const testDown3 = await measureDownload(10001000, 6);
  //logSpeedTestResult('10MB', testDown3);

  //const testDown4 = await measureDownload(25001000, 4);
  //logSpeedTestResult('25MB', testDown4);

  //const testDown5 = await measureDownload(100001000, 1);
  //logSpeedTestResult('100MB', testDown5);

  const downloadTests = [
    ...testDown1,
    //...testDown2,
    //...testDown3,
    //...testDown4,
    //...testDown5,
  ];
  logDownloadSpeed(downloadTests);

  const testUp1 = await measureUpload(11000, 2);
  //const testUp2 = await measureUpload(101000, 10);
  //const testUp3 = await measureUpload(1001000, 8);
  const uploadTests = [
    ...testUp1, 
    //...testUp2, 
    //...testUp3
  ];
  logUploadSpeed(uploadTests);
}

speedTest();
