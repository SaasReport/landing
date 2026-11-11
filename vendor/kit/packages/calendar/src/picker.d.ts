/** Date Picker — `<kit-date-picker>`: picker-core.js registered under that name. */
export * from "./picker-core.js";
import { DatePicker } from "./picker-core.js";
export { DatePicker as KitDatePicker };

declare global {
  interface HTMLElementTagNameMap { "kit-date-picker": DatePicker }
}
