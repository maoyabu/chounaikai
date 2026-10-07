import express from 'express';
import { legalDocuments } from '../content/legalDocuments.js';

export const legalRouter = express.Router();
for (const document of legalDocuments) {
  legalRouter.get(document.path, (_req, res) => {
    res.render('legal', { title: document.title, document, legalDocuments });
  });
}
