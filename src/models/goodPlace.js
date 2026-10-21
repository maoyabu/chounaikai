import mongoose from 'mongoose';
import { DangerReport } from './dangerReport.js';

// Share the report shape, with an independent collection and Drive photo identity.
const schema = DangerReport.schema.clone();
schema.path('photoAttachment').required(true);
export const GoodPlace = mongoose.model('GoodPlace', schema, 'good_place_reports');
