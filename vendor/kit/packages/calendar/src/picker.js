/* @saasreport/calendar date picker — <kit-date-picker>, a dependency-free web component on the calendar engine.
   The class lives in picker-core.js (DatePicker, with a configurable tag and class prefix); importing this module
   registers it as <kit-date-picker>. A project with its own element name imports picker-core.js instead. */
import { DatePicker, definePicker } from "./picker-core.js";

export * from "./picker-core.js";
export { DatePicker as KitDatePicker };
definePicker(DatePicker, "kit-date-picker");
