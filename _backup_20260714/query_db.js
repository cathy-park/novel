const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://vsmqtpavcvabalrveqma.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzbXF0cGF2Y3ZhYmFscnZlcW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDEzNjksImV4cCI6MjA5NzQxNzM2OX0.TFvpFln-1QunLVpxAZgQIHcfsJjsK6Anal8kI4zETNk');

async function run() {
  const { data, error } = await sb.from('novel_episodes').select('id, title, body, plan');
  if (error) {
    console.error(error);
    return;
  }
  let hasBody = 0;
  let emptyBody = 0;
  for (const row of data) {
    if (row.body && row.body.trim().length > 15 && row.body.trim() !== '<p><br></p>') hasBody++;
    else emptyBody++;
  }
  console.log(`Has body: ${hasBody}, Empty body: ${emptyBody}`);
  
  if (hasBody === 0) {
    console.log("ALL BODIES ARE EMPTY OR GONE.");
  }
}
run();
