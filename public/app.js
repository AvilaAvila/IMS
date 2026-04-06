(() => {
  function qs(sel) {
    return document.querySelector(sel);
  }
  function qsa(sel) {
    return Array.from(document.querySelectorAll(sel));
  }

  // AI enhance description
  const enhanceBtn = qs("[data-enhance-desc]");
  if (enhanceBtn) {
    enhanceBtn.addEventListener("click", async () => {
      const textarea = qs("#description");
      if (!textarea) return;

      const text = textarea.value.trim();
      if (text.length < 5) {
        alert("Type a bit more description first.");
        textarea.focus();
        return;
      }

      enhanceBtn.disabled = true;
      const oldLabel = enhanceBtn.textContent;
      enhanceBtn.textContent = "Enhancing…";

      try {
        const resp = await fetch("/api/enhance-description", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || "Enhance failed");
        textarea.value = data.text || textarea.value;
      } catch (e) {
        alert(e.message || "Could not enhance right now.");
      } finally {
        enhanceBtn.disabled = false;
        enhanceBtn.textContent = oldLabel;
      }
    });
  }

  // Voice-to-text for description (Web Speech API)
  const voiceBtn = qs("[data-voice-desc]");
  if (voiceBtn) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      voiceBtn.disabled = true;
      voiceBtn.title = "Voice input not supported in this browser.";
    } else {
      let recognition = null;
      let listening = false;

      voiceBtn.addEventListener("click", () => {
        const textarea = qs("#description");
        if (!textarea) return;

        if (!recognition) {
          recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = "en-US";

          recognition.onresult = (event) => {
            let finalText = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const res = event.results[i];
              if (res.isFinal) finalText += res[0].transcript;
            }
            if (finalText) {
              textarea.value = (textarea.value.trim() ? textarea.value.trim() + "\n\n" : "") + finalText.trim();
            }
          };

          recognition.onend = () => {
            listening = false;
            voiceBtn.textContent = "Voice";
          };
        }

        if (listening) {
          recognition.stop();
          listening = false;
          voiceBtn.textContent = "Voice";
        } else {
          try {
            recognition.start();
            listening = true;
            voiceBtn.textContent = "Stop";
          } catch (_e) {
            // ignore repeated start errors
          }
        }
      });
    }
  }

  // Video picker helper
  const videoPickBtn = qs("[data-pick-video]");
  if (videoPickBtn) {
    videoPickBtn.addEventListener("click", () => {
      const input = qs("#video");
      if (input) input.click();
    });
  }

  const videoInput = qs("#video");
  if (videoInput) {
    videoInput.addEventListener("change", () => {
      const label = qs("[data-video-label]");
      if (!label) return;
      const f = videoInput.files && videoInput.files[0];
      label.textContent = f ? `Selected: ${f.name}` : "No video selected";
    });
  }

  // Duplicate title check (blocks submit when >75%)
  const titleInput = qs("#title");
  const dupPercentEl = qs("[data-dup-percent]");
  const dupHintEl = qs("[data-dup-hint]");
  const submitBtn = qs("[data-submit-idea]");

  if (titleInput && dupPercentEl && dupHintEl && submitBtn) {
    let t = null;
    const controlsToDisable = [
      qs("#description"),
      qs("#attachment"),
      qs("#video"),
      qs("[data-enhance-desc]"),
      qs("[data-voice-desc]"),
      qs("[data-pick-video]"),
      submitBtn,
    ].filter(Boolean);

    const setDisabled = (disabled) => {
      controlsToDisable.forEach((el) => {
        el.disabled = !!disabled;
      });
    };

    const updateDup = async () => {
      const title = titleInput.value.trim();
      if (title.length < 3) {
        dupPercentEl.textContent = "0%";
        dupHintEl.textContent = "Type a title to check duplication.";
        setDisabled(false);
        return;
      }

      dupHintEl.textContent = "Checking…";
      try {
        const resp = await fetch(`/api/ideas/duplicate-check?title=${encodeURIComponent(title)}`, {
          headers: { accept: "application/json" },
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || "Duplicate check failed");

        const percent = Number(data.percent || 0);
        dupPercentEl.textContent = `${percent}%`;

        if (percent >= 75) {
          const m = data.bestMatch?.title ? ` Similar: "${data.bestMatch.title}".` : "";
          dupHintEl.textContent = `High duplication detected (${percent}%). Please change the title.${m}`;
          setDisabled(true);
          titleInput.disabled = false; // allow editing title
        } else {
          dupHintEl.textContent = data.bestMatch?.title
            ? `Closest match: "${data.bestMatch.title}" (${percent}%).`
            : "No close duplicates found.";
          setDisabled(false);
        }
      } catch (e) {
        dupHintEl.textContent = e.message || "Duplicate check failed.";
        setDisabled(false);
      }
    };

    titleInput.addEventListener("input", () => {
      if (t) clearTimeout(t);
      t = setTimeout(updateDup, 350);
    });
  }

  // Home: inline vote + comments/replies
  qsa("[data-idea-card]").forEach((card) => {
    const ideaId = Number(card.getAttribute("data-idea-card"));
    if (!ideaId) return;

    const voteBtn = card.querySelector("[data-vote-btn]");
    const voteCountEl = card.querySelector("[data-vote-count]");
    const commentCountEl = card.querySelector("[data-comment-count]");
    const toggleCommentsBtns = Array.from(card.querySelectorAll("[data-toggle-comments]"));
    const commentsPanel = card.querySelector("[data-comments-panel]");
    const commentsList = card.querySelector("[data-comments-list]");
    const commentForm = card.querySelector("[data-comment-form]");
    const commentInput = card.querySelector("[data-comment-input]");

    async function loadComments() {
      if (!commentsList) return;
      commentsList.textContent = "Loading…";
      const resp = await fetch(`/api/ideas/${ideaId}/comments`, { headers: { accept: "application/json" } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Failed to load comments");

      const rows = data.comments || [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const children = new Map();
      rows.forEach((r) => {
        const key = r.parentCommentId || 0;
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(r);
      });

      function renderThread(parentId, depth) {
        const items = children.get(parentId) || [];
        return items
          .map((c) => {
            const margin = Math.min(depth * 18, 72);
            return `
              <div class="comment" style="margin-left:${margin}px">
                <div class="row" style="justify-content:space-between;align-items:center">
                  <div><strong>${escapeHtml(c.authorName)}</strong></div>
                  <div class="muted small">${new Date(c.createdAt).toLocaleString()}</div>
                </div>
                <div style="margin-top:8px; white-space: pre-wrap;">${escapeHtml(c.content)}</div>
                <div class="row" style="margin-top:10px">
                  <button class="btn link small" type="button" data-reply-toggle="${c.id}">Reply</button>
                </div>
                <div data-reply-panel="${c.id}" style="display:none; margin-top:10px">
                  <div class="row" style="gap:8px; align-items:flex-start">
                    <textarea class="input" data-reply-input="${c.id}" placeholder="Write a reply..." style="min-height:70px"></textarea>
                    <button class="btn" type="button" data-reply-send="${c.id}">Send</button>
                  </div>
                </div>
              </div>
              ${renderThread(c.id, depth + 1)}
            `;
          })
          .join("");
      }

      commentsList.innerHTML = rows.length ? renderThread(0, 0) : `<div class="muted">No comments yet.</div>`;
    }

    function escapeHtml(s) {
      return String(s || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    async function postComment(content, parentCommentId) {
      const resp = await fetch(`/api/ideas/${ideaId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ content, parentCommentId: parentCommentId || null }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Failed to post comment");
      if (commentCountEl) commentCountEl.textContent = String(data.commentCount ?? "");
      return data;
    }

    if (toggleCommentsBtns.length && commentsPanel) {
      const toggle = async () => {
        const open = commentsPanel.style.display !== "none";
        commentsPanel.style.display = open ? "none" : "block";
        if (!open) {
          try {
            await loadComments();
          } catch (e) {
            commentsList.textContent = e.message || "Failed to load comments";
          }
        }
      };
      toggleCommentsBtns.forEach((b) => b.addEventListener("click", toggle));
    }

    if (commentForm && commentInput) {
      commentForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const content = commentInput.value.trim();
        if (content.length < 2) return;
        const submitBtn = commentForm.querySelector("button[type='submit']");
        if (submitBtn) submitBtn.disabled = true;
        try {
          await postComment(content, null);
          commentInput.value = "";
          await loadComments();
        } catch (err) {
          alert(err.message || "Failed to post comment");
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    if (commentsPanel) {
      commentsPanel.addEventListener("click", async (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;

        const toggle = t.getAttribute("data-reply-toggle");
        if (toggle) {
          const panel = commentsPanel.querySelector(`[data-reply-panel="${toggle}"]`);
          if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
          return;
        }

        const send = t.getAttribute("data-reply-send");
        if (send) {
          const input = commentsPanel.querySelector(`[data-reply-input="${send}"]`);
          const content = (input && "value" in input ? input.value : "").trim();
          if (!content) return;
          t.setAttribute("disabled", "true");
          try {
            await postComment(content, Number(send));
            if (input && "value" in input) input.value = "";
            await loadComments();
          } catch (err) {
            alert(err.message || "Failed to post reply");
          } finally {
            t.removeAttribute("disabled");
          }
        }
      });
    }

    if (voteBtn && voteCountEl) {
      voteBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        voteBtn.setAttribute("disabled", "true");
        try {
          const resp = await fetch(`/api/ideas/${ideaId}/vote`, {
            method: "POST",
            headers: { accept: "application/json" },
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.error || "Vote failed");
          voteCountEl.textContent = String(data.voteCount);
          voteBtn.textContent = data.hasVoted ? "Unvote" : "Vote";
        } catch (err) {
          alert(err.message || "Vote failed");
        } finally {
          voteBtn.removeAttribute("disabled");
        }
      });
    }
  });
})();

