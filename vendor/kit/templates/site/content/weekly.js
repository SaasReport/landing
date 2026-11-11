// SAMPLE CONTENT: two weekly topics to show the shape. Replace them with your own, one per Monday (series "weekly").
// Each topic has a written article (the blog post) and a short two-host talk (the weekly podcast episode).
export default [
  {
    date: "2026-09-28",
    title: "Sample topic: what a business day is, and why it moves your money",
    summary: "Payments and settlements count business days, not calendar days. A short, generic example of how weekends and holidays shift a due date.",
    tags: ["business days", "settlement", "sample"],
    article: `This is **sample content** from the kit starter. Replace it with your own topic.

When a bank or a broker says a payment settles "one business day" after it is made, the word *business* matters more than the number. A business day is a day on which the institutions involved are open: most calendars skip weekends and public holidays.

## Why it matters

If a payment is made on a Friday, the next business day is usually Monday, not Saturday. A long holiday weekend can push the date out even further. A product that simply adds one calendar day promises the customer something the payment network will not deliver, and a finance team that plans cash with calendar days will find money missing on the day it expected it.

## What to do

Keep one shared calendar of business days, with every public holiday for the markets you serve, and compute due dates with it everywhere: in the app, in reports and in customer messages. Show the resulting date, not the rule, so nobody has to count.`,
    talk: [
      ["host", "Today's question sounds simple: what exactly is a business day?"],
      ["expert", "It's a day when the banks and the other institutions involved are open. Weekends and public holidays usually don't count."],
      ["host", "So if my transfer settles one business day later and I send it on a Friday?"],
      ["expert", "Then it usually lands on Monday, not on Saturday. And before a long holiday weekend it can take even longer."],
      ["host", "That sounds like a small detail. Why does it matter so much?"],
      ["expert", "Because people plan with those dates. If an app just adds one calendar day, it promises something the payment network won't deliver."],
      ["host", "So what should a product team actually do about it?"],
      ["expert", "Keep one shared calendar with every holiday, use it everywhere, and show customers the actual date instead of the rule."],
      ["host", "Does that also help the finance team?"],
      ["expert", "A lot. When everyone uses the same calendar, cash plans, reports and customer messages all agree on the same dates."],
    ],
  },
  {
    date: "2026-10-05",
    title: "Sample topic: compound interest, explained without formulas",
    summary: "Interest that earns interest: a generic, formula-free example of why time matters more than the starting amount.",
    tags: ["saving", "interest", "sample"],
    article: `This is **sample content** from the kit starter. Replace it with your own topic.

Compound interest means that the interest you earn is added to your balance, and from then on it earns interest too. In the first months the difference from simple interest is tiny. Over years it becomes the largest part of the balance.

## Time does the heavy lifting

Two people save the same amount every month. One starts early, the other starts much later and saves for fewer years. The early saver often ends up with more, even after putting in less, because the early deposits had more time to grow. The same effect works against borrowers: unpaid interest on a card or a loan is added to the debt and then charged interest itself.

## What to look at

When you compare savings products or loans, look at how often interest is added (monthly, yearly) and at the effective annual rate, which already includes compounding. For debt, paying down the balance early is the most reliable way to stop interest from growing on interest.`,
    talk: [
      ["host", "Everyone says compound interest is magic. What is it, in plain words?"],
      ["expert", "Interest that earns interest. What you earn is added to your balance, and from then on it earns interest as well."],
      ["host", "Does that really make a big difference?"],
      ["expert", "Not in the first months. But over many years, the interest on interest can become the biggest part of the balance."],
      ["host", "So starting early matters more than saving a lot?"],
      ["expert", "Very often, yes. Early deposits simply have more time to grow, so a late start is hard to catch up with."],
      ["host", "And does it work the same way for debt?"],
      ["expert", "Exactly the same, just against you. Unpaid interest on a card is added to the debt, so paying early is the best defence."],
      ["host", "What is the one thing listeners should check this week?"],
      ["expert", "How often interest is added on their savings and loans, and the effective annual rate, which already includes compounding. That single number makes offers comparable."],
    ],
  },
];
