const { neon } = require('@neondatabase/serverless');
const sql = (process.env.DATABASE_URL || process.env.STORAGE_DATABASE_URL) ? neon(process.env.DATABASE_URL || process.env.STORAGE_DATABASE_URL) : null;
const studentsDefault = [
  ["Elise Arrieta","Line Leader"],["Guhan Aroul","Door Holder"],["Casper Kamali","Light Helper"],
  ["Ruby Rodriguez","Calendar Helper"],["James Selkirk","Weather Monitor"],["Lucy Hammer","Snack Helpers"],
  ["Nicholas Luna","Snack Helpers"],["Eliana Ayala","Sweeper"],["James Leibfarth","Pencil Patrol"],
  ["Zedek Lobo","Librarian"],["Eli Hamilton","Paper Passer"],["Jenna Jonson","Caboose"],
  ["Owen Alspach","Purple Folder Monitor"],["Eleanor Pelletier","Teacher Helper"]
];
const jobs=["Line Leader","Door Holder","Light Helper","Calendar Helper","Weather Monitor","Snack Helpers","Sweeper","Pencil Patrol","Librarian","Paper Passer","Caboose","Purple Folder Monitor","Teacher Helper","Stand-In Star"];
function monthKey(){return new Date().toISOString().slice(0,7)}
async function init(){
  await sql`CREATE TABLE IF NOT EXISTS students(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,current_job TEXT)`;
  await sql`CREATE TABLE IF NOT EXISTS jobs(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS ballots(month_key TEXT NOT NULL,student_name TEXT NOT NULL,first_choice TEXT,second_choice TEXT,third_choice TEXT,submitted_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(month_key,student_name))`;
  await sql`CREATE TABLE IF NOT EXISTS assignments(month_key TEXT NOT NULL,student_name TEXT NOT NULL,job_name TEXT NOT NULL,finalized_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(month_key,student_name))`;
  await sql`CREATE TABLE IF NOT EXISTS job_history(id SERIAL PRIMARY KEY,student_name TEXT NOT NULL,job_name TEXT NOT NULL,month_key TEXT NOT NULL)`;
  for(const [name,job] of studentsDefault) await sql`INSERT INTO students(name,current_job) VALUES(${name},${job}) ON CONFLICT(name) DO NOTHING`;
  for(const job of jobs) await sql`INSERT INTO jobs(name) VALUES(${job}) ON CONFLICT(name) DO NOTHING`;
  for(const [name,job] of studentsDefault) await sql`INSERT INTO job_history(student_name,job_name,month_key) VALUES(${name},${job},'initial') ON CONFLICT DO NOTHING`;
}
module.exports = async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,x-teacher-pin');
  if(req.method==='OPTIONS') return res.status(204).end();
  if(!sql) return res.status(500).json({error:'Database is not connected yet. Connect a Neon Postgres store to this Vercel project.'});
  try{
    await init(); const action=req.query.action||'bootstrap'; const mk=monthKey();
    if(action==='bootstrap'){
      const [s,j,b,a,h]=await Promise.all([
        sql`SELECT name,current_job FROM students ORDER BY id`,sql`SELECT name FROM jobs ORDER BY id`,
        sql`SELECT * FROM ballots WHERE month_key=${mk} ORDER BY student_name`,
        sql`SELECT * FROM assignments WHERE month_key=${mk} ORDER BY student_name`,
        sql`SELECT student_name,job_name,month_key FROM job_history ORDER BY student_name,month_key`
      ]);
      return res.json({monthKey:mk,students:s,jobs:j.map(x=>x.name),ballots:b,assignments:a,history:h});
    }
    const body=req.body||{};
    if(action==='ballot'){
      const {studentName,first,second,third}=body;
      if(!studentName||![first,second,third].every(Boolean)||new Set([first,second,third]).size!==3) return res.status(400).json({error:'Please provide three different choices.'});
      await sql`INSERT INTO ballots(month_key,student_name,first_choice,second_choice,third_choice) VALUES(${mk},${studentName},${first},${second},${third}) ON CONFLICT(month_key,student_name) DO UPDATE SET first_choice=EXCLUDED.first_choice,second_choice=EXCLUDED.second_choice,third_choice=EXCLUDED.third_choice,submitted_at=now()`;
      return res.json({ok:true});
    }
    if(action==='clearBallot'){
      const pin=req.headers['x-teacher-pin'];if(process.env.TEACHER_PIN && pin!==process.env.TEACHER_PIN) return res.status(401).json({error:'Teacher PIN required.'});
      const {studentName}=body;if(!studentName) return res.status(400).json({error:'Student name required'});
      await sql`DELETE FROM ballots WHERE month_key=${mk} AND student_name=${studentName}`;
      return res.json({ok:true});
    }
    if(action==='addStudent'){
      const {name,currentJob}=body;if(!name) return res.status(400).json({error:'Name required'});
      await sql`INSERT INTO students(name,current_job) VALUES(${name},${currentJob||null}) ON CONFLICT(name) DO UPDATE SET current_job=EXCLUDED.current_job`;
      if(currentJob) await sql`INSERT INTO job_history(student_name,job_name,month_key) VALUES(${name},${currentJob,'initial'})`;
      return res.json({ok:true});
    }
    if(action==='finalize'){
      const pin=req.headers['x-teacher-pin'];if(process.env.TEACHER_PIN && pin!==process.env.TEACHER_PIN) return res.status(401).json({error:'Teacher PIN required.'});
      const assignments=body.assignments||[];if(!assignments.length) return res.status(400).json({error:'No assignments supplied.'});
      for(const x of assignments){
        await sql`INSERT INTO assignments(month_key,student_name,job_name) VALUES(${mk},${x.studentName},${x.jobName}) ON CONFLICT(month_key,student_name) DO UPDATE SET job_name=EXCLUDED.job_name,finalized_at=now()`;
        await sql`INSERT INTO job_history(student_name,job_name,month_key) VALUES(${x.studentName},${x.jobName},${mk})`;
        await sql`UPDATE students SET current_job=${x.jobName} WHERE name=${x.studentName}`;
      }
      return res.json({ok:true});
    }
    if(action==='startMonth'){
      return res.json({ok:true,newMonth:mk,note:'Monthly ballots are keyed by month; finalized history remains stored.'});
    }
    return res.status(404).json({error:'Unknown action'});
  }catch(e){console.error(e);return res.status(500).json({error:e.message})}
};