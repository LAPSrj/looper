// wsl.exe's own error messages, verbatim (WSL 3.0.1.0).

/** The VM could not open a session for wsl.exe: the step never started. */
export const WSL_TIMEOUT_TEXT =
  'A connection attempt failed because the connected party did not properly respond after a period of time, ' +
  'or established connection failed because connected host has failed to respond. \r\n' +
  'Error code: Wsl/Service/WSAETIMEDOUT\r\n' +
  'If this error was unexpected, please consider searching for existing issues or filing a new issue at https://github.com/microsoft/WSL/issues.\r\n';

/** The task names a distro that isn't installed: its configuration, not the machine. */
export const WSL_DISTRO_MISSING_TEXT =
  'There is no distribution with the supplied name.\r\n' +
  'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n' +
  'If this error was unexpected, please consider searching for existing issues or filing a new issue at https://github.com/microsoft/WSL/issues.\r\n';
