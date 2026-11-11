// A fixture engine: the due date of a loan from the build date.
export default {
  due: ({ days = 14 }, { asOf, addDays }) => ({ date: addDays(asOf, days), label: { en: `Due in ${days} days`, fa: `سررسید ${days} روز دیگر` } }),
};
