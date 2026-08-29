<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false displayWide=false showAnotherWayIfPresent=true>
<!DOCTYPE html>
<html class="kc-html"<#if realm.internationalizationEnabled && locale??> lang="${locale.currentLanguageTag}"</#if>>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign in, Catalog Sentinel</title>
  <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/img/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${url.resourcesPath}/css/sentinel.css">
</head>
<body class="kc-body">
  <div class="kc-shell">
    <main class="kc-card" role="main">
      <div class="kc-brand">
        Catalog Sentinel
        <span>catalog operations</span>
      </div>

      <#-- Page heading, supplied by each page's "header" section -->
      <header class="kc-head">
        <h1 class="kc-title"><#nested "header"></h1>
      </header>

      <#-- Global alerts (error / warning / success / info) -->
      <#if displayMessage && message?has_content && (message.summary!'')?has_content>
        <div class="kc-alert kc-alert-${message.type}" role="alert">
          <span>${kcSanitize(message.summary)?no_esc}</span>
        </div>
      </#if>

      <div class="kc-content">
        <#nested "form">

        <#if auth?has_content && auth.showTryAnotherWayLink() && showAnotherWayIfPresent>
          <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" class="kc-another-way">
            <input type="hidden" name="tryAnotherWay" value="on"/>
            <a href="#" class="kc-link" onclick="document.getElementById('kc-select-try-another-way-form').submit();return false;">${msg("doTryAnotherWay")}</a>
          </form>
        </#if>

        <#if displayInfo>
          <div class="kc-info">
            <#nested "info">
          </div>
        </#if>
      </div>
    </main>
  </div>
</body>
</html>
</#macro>
