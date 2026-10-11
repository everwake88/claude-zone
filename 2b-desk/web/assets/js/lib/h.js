// Preact + htm, vendored: components without a build step.
import { h, render, Fragment } from '../../vendor/preact.module.js';
import {
  useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useReducer,
} from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';

export const html = htm.bind(h);
export { h, render, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useReducer };
