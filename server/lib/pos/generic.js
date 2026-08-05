// The fallback for a POS we have not written a module for yet.
//
// It knows the vocabulary every POS shares and nothing vendor-specific, so it
// gets a club running on day one and its diagnostics tell us what to put in
// the real module. Its detect() returns a floor value, so any vendor module
// that recognises the file wins.

const profile = {
  id: "generic",
  label: "POS export",
  outletLabel: "outlet",

  detect() { return 0.01; },

  // The first matcher of each field is the exact name used by the CSV template
  // the dashboard hands out, so a club that fills that in and uploads the file
  // directly is read without any guessing at all.
  columns: {
    member_id: [
      /^member id$/,
      /^(member|customer|account|acct|membership)\s*(#|no|num|number|id|code)$/,
      (h) => /\b(member|customer|account|acct)\b/.test(h) && /\b(no|num|number|id|code)\b/.test(h) && !/name/.test(h),
    ],
    member_name: [
      /^member name$/,
      /^(member|customer|guest|patron)\s*name$/,
      /^(member|customer|name)$/,
      (h) => /\b(member|customer|guest)\b/.test(h) && /name/.test(h),
    ],
    outlet_name: [
      /^outlet name$/,
      /^(outlet|location|venue|restaurant|shop|department|dept|store)\s*(name)?$/,
      /^(revenue|cost|profit)\s*cent(er|re)$/,
      (h) => /\b(outlet|location|venue|department|shop)\b/.test(h),
    ],
    spend_amount: [
      /^spend\s*amount$/,
      /^(net|net\s*sales|sub\s*total|subtotal|item\s*total)$/,
      /^(spend|sales|net\s*amount)$/,
    ],
    check_total: [
      /^(grand\s*total|check\s*total|total\s*amount|gross)$/,
      /^(total|amount)$/,
    ],
    visit_date: [
      /^visit date$/,
      /^(visit|trans(action)?|business|sale|check|order)\s*date$/,
      /^date$/,
      (h) => /\bdate\b/.test(h) && !/print|run|export|range|from|to/.test(h),
    ],
    check_number: [
      /^(check|ticket|receipt|order|invoice|trans(action)?)\s*(#|no|num|number)$/,
    ],
    guest_name: [/^guest name$/],
    server_name: [
      /^server name$/,
      /^(server|waiter|waitress|employee|staff|cashier)\s*(name)?$/,
    ],
    covers: [/^(covers|cvrs|guests|pax|seats)$/],
  },
};

module.exports = profile;
