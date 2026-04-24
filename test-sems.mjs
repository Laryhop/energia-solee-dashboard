import fs from 'fs';
const envFile = fs.readFileSync('.env.local', 'utf8');
envFile.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    process.env[key.trim()] = value.trim().replace(/"/g, '');
  }
});

async function semsRequest(path, session, payload) {
  const tokenHeader = JSON.stringify({
    uid: session.uid,
    timestamp: session.timestamp,
    token: session.token,
    client: 'ios',
    version: 'v2.1.0',
    language: 'en',
  });

  const response = await fetch(`https://www.semsportal.com/api/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: tokenHeader,
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`SEMS respondeu com ${response.status}`);
  }

  return response.json();
}

async function login() {
  const response = await fetch(`https://www.semsportal.com/api/v2/Common/CrossLogin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: JSON.stringify({
        client: 'ios',
        version: 'v2.1.0',
        language: 'en',
      }),
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      account: process.env.SEMS_USER,
      pwd: process.env.SEMS_PASS,
    }),
  });
  const data = await response.json();
  return { uid: data.data.uid, token: data.data.token, timestamp: data.data.timestamp };
}

async function run() {
  try {
    const session = await login();
    console.log("Login OK");

    const plantId = process.env.SEMS_PLANT_ID || "3bf3d74c-4903-490b-ba62-35ca167cd130"; // Example, will need real one
    
    // First let's get the real plant ID if not in env
    let realPlantId = process.env.SEMS_PLANT_ID;
    if (!realPlantId) {
      const plantsRes = await semsRequest("PowerStationMonitor/QueryPowerStationMonitorForAppNew", session, {});
      if (plantsRes.data && plantsRes.data.length > 0) {
        realPlantId = plantsRes.data[0].powerStationId || plantsRes.data[0].id;
      }
    }
    console.log("Plant ID:", realPlantId);

    const today = new Date().toISOString().slice(0, 10);
    const res = await semsRequest("PowerStationMonitor/GetPowerStationPowerAndIncomeByDay", session, {
      powerstation_id: realPlantId,
      date: today,
      count: 31,
      id: realPlantId,
    });
    console.log("GetPowerStationPowerAndIncomeByDay response:");
    console.log(JSON.stringify(res, null, 2));

  } catch (err) {
    console.error(err);
  }
}

run();
