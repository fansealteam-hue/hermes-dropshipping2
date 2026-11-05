#!/usr/bin/env node
/**
 * Connecter un compte Leboncoin à Tyno (à lancer sur TON ordinateur, pas sur le VPS).
 *
 *   node apps/backend/scripts/lbc-session.js <identifiant_du_compte>
 *   ex. node apps/backend/scripts/lbc-session.js lbc_maison
 *
 * Une vraie fenêtre Chromium s'ouvre sur Leboncoin : tu te connectes toi-même
 * (email, mot de passe, code reçu…). Tyno ne voit jamais ton mot de passe.
 * Une fois connecté, reviens dans le terminal et appuie sur Entrée : la session
 * (les cookies) est enregistrée dans ./sessions/<identifiant>.json.
 *
 * Ensuite, copie ce fichier dans le conteneur du VPS :
 *   scp sessions/lbc_maison.json root@IP_DU_VPS:/root/
 *   (sur le VPS, dans le dossier du projet)
 *   docker compose cp /root/lbc_maison.json backend:/data/hermes/sessions/lbc_maison.json
 *
 * La session expire de temps en temps (Leboncoin te redemande de te connecter) :
 * il suffit de relancer ce script.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const id = process.argv[2];
if (!id || !/^[a-z0-9_-]{2,40}$/i.test(id)) {
  console.error("Usage : node apps/backend/scripts/lbc-session.js <identifiant_du_compte>   (lettres, chiffres, _ ou -)");
  process.exit(1);
}

(async () => {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch {
    console.error("Playwright manque : lance d'abord « npm install » à la racine du projet, puis « npx playwright install chromium ».");
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "fr-FR", viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto("https://www.leboncoin.fr/");
  console.log("\n👉 Connecte-toi à Leboncoin dans la fenêtre qui vient de s'ouvrir.");
  console.log("   Quand tu vois ton compte connecté, reviens ici et appuie sur Entrée.\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question("Entrée quand c'est fait… ", () => { rl.close(); r(); }));
  const dir = path.join(process.cwd(), "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  await context.storageState({ path: file });
  fs.chmodSync(file, 0o600); // fichier sensible : lisible par toi seul
  await browser.close();
  console.log(`\n✅ Session enregistrée : ${file}`);
  console.log("   Garde ce fichier pour toi : il donne accès à ton compte Leboncoin.");
  console.log(`   Copie-le sur le VPS : docker compose cp ${id}.json backend:/data/hermes/sessions/${id}.json\n`);
})().catch((e) => { console.error("Erreur :", e.message); process.exit(1); });
