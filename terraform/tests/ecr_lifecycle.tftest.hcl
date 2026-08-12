# =============================================================================
# ECR lifecycle policy — a tagged image index can never lose its children
# =============================================================================
# ticket 03. Multi-arch / attested builds publish an OCI image *index*: the tag
# sits on the index, and its per-architecture child manifests are reported as
# untagged. Rule 1 ("expire untagged after 1 day") looks like it would delete
# those children and leave a dangling, unpullable tag that IMMUTABLE then forbids
# re-pushing.
#
# It cannot, because ECR's lifecycle evaluator exempts them:
#   "If an image is referenced by a manifest list, it cannot be expired or
#    archived without the manifest list being deleted or archived first."
#   — https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html
#
# That exemption holds only while the index itself survives. So the invariant the
# policy must keep is: NO rule may select a live tagged index by age. These
# assertions fail the plan if that shape ever reappears — a widened rule 1, a
# `tagStatus: "any"` rule, or an age-based expiry on tagged images.
#
# Runs offline against a mocked AWS provider (no creds, no API calls) — same
# arrangement as plan_assertions.tftest.hcl.
# =============================================================================

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }
}

variables {
  project_name                    = "flylive-audio"
  replication_destination_regions = []
}

run "untagged_rule_cannot_expire_a_child_of_a_tagged_index" {
  command = plan

  module {
    source = "./modules/ecr"
  }

  # --- The untagged rule stays untagged-only ------------------------------
  # modules/ecr/main.tf rule 1: selection.tagStatus = "untagged". Widening this
  # to "any" (or adding tagPrefixList) would make it select the tagged index,
  # and deleting the index lifts the exemption on its children.
  assert {
    condition = alltrue([
      for rule in jsondecode(aws_ecr_lifecycle_policy.msab.policy).rules :
      rule.selection.tagStatus != "any"
    ])
    error_message = "No ECR lifecycle rule may use tagStatus \"any\" — it selects tagged image indexes, and deleting an index also removes its (then unreferenced) child manifests"
  }

  # --- No age-based expiry of tagged images -------------------------------
  # Age (`sinceImagePushed`) applied to tagged images would delete a pinned
  # rollback artifact simply for being old — the exact artifact ticket 03 exists
  # to preserve. Tagged retention must stay count-based.
  assert {
    condition = alltrue([
      for rule in jsondecode(aws_ecr_lifecycle_policy.msab.policy).rules :
      rule.selection.countType == "imageCountMoreThan"
      if rule.selection.tagStatus == "tagged"
    ])
    error_message = "Tagged-image retention must be count-based (imageCountMoreThan) — an age-based rule expires pinned rollback artifacts and orphans their child manifests"
  }

  # --- The untagged rule still exists, and there is exactly one -----------
  # Reclaiming genuinely orphaned layers is the rule's real job. ECR also refuses
  # more than one: "Only one rule selecting a specific storage class is allowed to
  # select untagged images." (same page) — a second one is an apply-time error, so
  # catch it at plan time instead.
  assert {
    condition = length([
      for rule in jsondecode(aws_ecr_lifecycle_policy.msab.policy).rules :
      rule if rule.selection.tagStatus == "untagged"
    ]) == 1
    error_message = "Expected exactly one untagged-expiry rule in the ECR lifecycle policy"
  }

  # --- IMMUTABLE and the policy must be evaluated together ----------------
  # The dangling-tag failure mode needs BOTH: an expiry that can strip children
  # AND immutability blocking the repair push. Assert the second half here so a
  # future mutability flip surfaces against this reasoning, not just against
  # ticket 14's standalone test.
  assert {
    condition     = aws_ecr_repository.msab.image_tag_mutability == "IMMUTABLE"
    error_message = "ECR must stay IMMUTABLE — a re-push cannot be the recovery path for a broken tag"
  }
}
