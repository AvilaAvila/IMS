const IDEA_STATUSES = ["approved", "inprogress", "closed"];

function ideaStatusLabel(status) {
  switch (status) {
    case "approved":
      return "Approved";
    case "inprogress":
      return "In progress";
    case "closed":
      return "Closed";
    default:
      return "Unknown";
  }
}

function isValidIdeaStatus(status) {
  return IDEA_STATUSES.includes(status);
}

module.exports = { IDEA_STATUSES, ideaStatusLabel, isValidIdeaStatus };

