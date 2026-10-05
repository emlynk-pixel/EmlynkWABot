async function run() {
  const res = await fetch("https://emlynk-wa-bot-git-stage-emlynk-pixel.vercel.app/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  console.log(res.status);
  console.log(await res.text());
}
run();
