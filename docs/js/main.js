/* ==========================================================================
   图提取 ImageGrab — 官网交互
   - 移动端导航展开 / 收起
   - 滚动时导航栏状态与当前章节高亮
   - IntersectionObserver 滚动淡入
   - 复制 chrome://extensions 地址
   - 页脚年份
   ========================================================================== */
(function () {
  "use strict";

  var doc = document;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ----------------------------------------------------------------------
     移动端导航
     ---------------------------------------------------------------------- */
  var header = doc.querySelector("[data-header]");
  var nav = doc.getElementById("site-nav");
  var navToggle = doc.querySelector("[data-nav-toggle]");
  var navLinks = Array.prototype.slice.call(
    doc.querySelectorAll("[data-nav-link]")
  );

  function setNav(open) {
    if (!nav || !navToggle) {
      return;
    }
    nav.dataset.open = open ? "true" : "false";
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
  }

  function isNavOpen() {
    return nav && nav.dataset.open === "true";
  }

  if (navToggle) {
    navToggle.addEventListener("click", function () {
      setNav(!isNavOpen());
    });
  }

  navLinks.forEach(function (link) {
    link.addEventListener("click", function () {
      setNav(false);
    });
  });

  doc.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !isNavOpen()) {
      return;
    }
    var focusWasInside = nav.contains(doc.activeElement);
    setNav(false);
    if (focusWasInside && navToggle) {
      navToggle.focus();
    }
  });

  doc.addEventListener("click", function (event) {
    if (!isNavOpen()) {
      return;
    }
    if (nav.contains(event.target) || navToggle.contains(event.target)) {
      return;
    }
    setNav(false);
  });

  var desktopQuery = window.matchMedia("(min-width: 901px)");
  function handleDesktopChange(event) {
    if (event.matches) {
      setNav(false);
    }
  }
  if (typeof desktopQuery.addEventListener === "function") {
    desktopQuery.addEventListener("change", handleDesktopChange);
  } else if (typeof desktopQuery.addListener === "function") {
    desktopQuery.addListener(handleDesktopChange);
  }

  /* ----------------------------------------------------------------------
     滚动状态：导航栏阴影
     ---------------------------------------------------------------------- */
  var scrollTicking = false;

  function updateHeaderOnScroll() {
    if (header) {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    }
    scrollTicking = false;
  }

  function requestScrollUpdate() {
    if (scrollTicking) {
      return;
    }
    scrollTicking = true;
    window.requestAnimationFrame(updateHeaderOnScroll);
  }

  updateHeaderOnScroll();
  window.addEventListener("scroll", requestScrollUpdate, { passive: true });

  /* ----------------------------------------------------------------------
     滚动淡入
     ---------------------------------------------------------------------- */
  var revealItems = Array.prototype.slice.call(
    doc.querySelectorAll(".reveal")
  );

  // 同一组内的元素依次延迟出现，形成轻微的节奏感
  Array.prototype.forEach.call(
    doc.querySelectorAll("[data-reveal-group]"),
    function (group) {
      Array.prototype.forEach.call(
        group.querySelectorAll(":scope > .reveal"),
        function (item, index) {
          item.style.setProperty(
            "--reveal-delay",
            Math.min(index * 70, 350) + "ms"
          );
        }
      );
    }
  );

  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) {
            return;
          }
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );

    revealItems.forEach(function (item) {
      revealObserver.observe(item);
    });
  } else {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
  }

  /* ----------------------------------------------------------------------
     当前章节高亮
     ---------------------------------------------------------------------- */
  var sections = navLinks
    .map(function (link) {
      var href = link.getAttribute("href") || "";
      return href.charAt(0) === "#" ? doc.querySelector(href) : null;
    })
    .filter(Boolean);

  function setActiveLink(id) {
    navLinks.forEach(function (link) {
      var active = link.getAttribute("href") === "#" + id;
      link.classList.toggle("is-active", active);
      if (active) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  if ("IntersectionObserver" in window && sections.length) {
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            setActiveLink(entry.target.id);
          }
        });
      },
      { rootMargin: "-42% 0px -52% 0px", threshold: 0 }
    );

    sections.forEach(function (section) {
      sectionObserver.observe(section);
    });
  }

  /* ----------------------------------------------------------------------
     复制扩展管理页地址
     ---------------------------------------------------------------------- */
  var copyButton = doc.querySelector("[data-copy]");
  var copyStatus = doc.querySelector("[data-copy-status]");
  var copyResetTimer = null;

  function showCopyStatus(message) {
    if (!copyStatus) {
      return;
    }
    copyStatus.textContent = message;
    window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(function () {
      copyStatus.textContent = "";
    }, 2200);
  }

  function fallbackCopy(text) {
    var textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    doc.body.appendChild(textarea);
    textarea.select();

    var copied = false;
    try {
      copied = doc.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    doc.body.removeChild(textarea);

    if (!copied) {
      showCopyStatus("请手动复制");
    }
    return copied;
  }

  if (copyButton) {
    copyButton.addEventListener("click", function () {
      var text = copyButton.getAttribute("data-copy") || "";

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            showCopyStatus("已复制");
          },
          function () {
            if (fallbackCopy(text)) {
              showCopyStatus("已复制");
            }
          }
        );
      } else if (fallbackCopy(text)) {
        showCopyStatus("已复制");
      }
    });
  }

  /* ----------------------------------------------------------------------
     页脚年份
     ---------------------------------------------------------------------- */
  var year = String(new Date().getFullYear());
  Array.prototype.forEach.call(doc.querySelectorAll("[data-year]"), function (el) {
    el.textContent = year;
  });
})();
