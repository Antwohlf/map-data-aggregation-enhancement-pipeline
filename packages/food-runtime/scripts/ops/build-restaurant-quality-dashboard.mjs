#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),get=key=>args.includes(key)?args[args.indexOf(key)+1]:null;
const input=get('--input'),output=get('--output');if(!input||!output)throw Error('--input <snapshot.json> --output <directory> required');
const data=JSON.parse(readFileSync(input,'utf8'));if(!Array.isArray(data.entities)||!data.generatedAt)throw Error('Invalid quality snapshot');
const source=fileURLToPath(new URL('../../dashboard/',import.meta.url));
const css=readFileSync(source+'style.css','utf8'),js=readFileSync(source+'dashboard.js','utf8');
const html=readFileSync(source+'index.html','utf8').replace('<link rel="stylesheet" href="style.css">',()=>`<style>${css}</style>`).replace('<script src="dashboard.js"></script>',()=>`<script id="quality-data" type="application/json">${JSON.stringify(data).replaceAll('<','\\u003c')}</script><script>${js}</script>`);
mkdirSync(resolve(output),{recursive:true});writeFileSync(resolve(output,'index.html'),html);copyFileSync(input,resolve(output,'restaurant-quality.json'));console.log(resolve(output,'index.html'));
