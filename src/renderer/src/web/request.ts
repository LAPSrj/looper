// Relative import: session.ts is loaded by the unit tests, which have no `@shared` alias.
import { REQUEST_HEADER, REQUEST_HEADER_VALUE } from '../../../shared/remote-access';

/** The headers every POST to the computer carries (see REQUEST_HEADER), plus `extra`. */
export const requestHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({ [REQUEST_HEADER]: REQUEST_HEADER_VALUE, ...extra });
