// Who a case alert belongs to.
//
// An alert knows the outlet the visit was to, and an outlet knows who runs it.
// That is the whole rule — location decides the owner. It is here rather than
// inline in the response route so the fallbacks are visible in one place and
// testable without a database.
//
// The fallbacks matter more than the happy path. An alert that reaches nobody
// is worse than one that reaches too many people, so every route out of this
// function ends with somebody being told.

// outlet: the outlets row for the visit, or null (an event survey has no
//   outlet, and neither does a response whose visit was deleted).
// owner:  the staff row named by outlet.owner_staff_id, or null.
//
// Returns { assignedTo, notify, reason } where notify is 'owner' or
// 'managers' — never neither.
function routeAlert({ outlet = null, owner = null } = {}) {
  if (!outlet) {
    return {
      assignedTo: null,
      notify: "managers",
      reason: "no outlet on this response, so there is no location to route by",
    };
  }

  if (!owner) {
    return {
      assignedTo: null,
      notify: "managers",
      reason: `${outlet.name || "this outlet"} has no owner set — assign one in Settings → Outlets`,
    };
  }

  // Somebody who has left. The foreign key sets owner_staff_id to null on
  // delete, but deactivation is a soft delete and leaves the row in place.
  if (owner.active === false) {
    return {
      assignedTo: null,
      notify: "managers",
      reason: `${owner.name} is no longer active — reassign ${outlet.name || "this outlet"} in Settings → Outlets`,
    };
  }

  // An owner with no email can hold the alert but cannot be told about it, so
  // the managers are notified as well as the assignment being made.
  if (!owner.email) {
    return {
      assignedTo: owner.staff_id,
      notify: "managers",
      reason: `assigned to ${owner.name}, who has no email address on file`,
    };
  }

  return {
    assignedTo: owner.staff_id,
    notify: "owner",
    reason: `${outlet.name || "the outlet"} is owned by ${owner.name}`,
  };
}

module.exports = { routeAlert };
