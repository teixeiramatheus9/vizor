// app.js is a classic script: this hands it the shared guard card module.
import { guardSpeech, renderGuardCard } from './guard-card.js';
import { needsYou } from '../main/session-status.js';

window.vizorNeedsYou = needsYou;
window.vizorGuardCard = { renderGuardCard, guardSpeech };
