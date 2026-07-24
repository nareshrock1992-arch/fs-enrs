/**
 * Platform driver registry.
 *
 * The active driver is set once at startup by the route bootstrap code.
 * Call setDriver(new FreeSwitchDriver(...)) before registering routes.
 * getDriver() throws a clear error if called before initialization.
 */

let _driver = null;

export function getDriver() {
  if (!_driver) {
    throw new Error(
      '[platform] Driver not initialized. Call setDriver() during server boot ' +
      'before any platform/config routes are registered.'
    );
  }
  return _driver;
}

export function setDriver(driver) {
  _driver = driver;
}
