"use strict";
import { createRenderer, subscribe } from "./overlay-core.js";

const stage = document.querySelector("#overlay-stage"), alert = document.querySelector("#overlay-alert");
const renderer = createRenderer(stage);
let latest = null, connected = false;
function draw() { if (latest) renderer.render(latest); }
subscribe(snapshot => { latest = snapshot; draw(); }, ok => { connected = ok; alert.hidden = ok; });
setInterval(() => { if (!document.hidden) { draw(); if (!connected) alert.hidden = false; } }, 1000);
