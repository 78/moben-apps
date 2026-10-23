// Entry for `moben app validate|page|action|voice`, which load the app without
// connecting. To run it, use `moben-codex` (src/cli.ts): it allows one instance.
import { connect } from '@moben-ai/app-sdk';
import { app } from './src/app';

connect(app);
