const { createClient } = require('@supabase/supabase-js');
// Need to check if upsert omits undefined or sets to null
console.log(JSON.stringify({ a: 1, b: undefined }));
