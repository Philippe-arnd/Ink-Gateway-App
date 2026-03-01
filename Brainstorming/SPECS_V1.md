# Ink-Gateway Web App - Spécifications V1 (Mars 2026)

## 1. Vue d'Ensemble du Projet

*   **Nom :** Ink-Gateway Web App
*   **Objectif :** Plateforme d'écriture de nouvelles et livres payante, assistée par IA.
*   **Public Cible :** Écrivains cherchant un éditeur de texte robuste avec des capacités de versioning et d'assistance IA (Claude Code / Gemini).

## 2. Choix Techniques Validés pour la V1

*   **Front-end :** Éditeur de texte (à développer, CKEditor 5 recommandé).
*   **Back-end Core :** Rust (CLI Ink-Gateway existant, MCP à intégrer).
*   **Authentification Utilisateur :** PostgreSQL.
*   **Gestion du Versioning des Documents Utilisateurs :**
    *   **Contenu du document :** Stocké sur Scaleway S3 (objets versionnés par timestamp).
    *   **Métadonnées de version (timestamps, ID doc, ID user, chemin S3) :** Stockées dans PostgreSQL.
*   **Intégration IA :** Via clés API Claude Code ou Gemini, orchestrées par le MCP Rust.

## 3. Contraintes et Objectifs de Performance V1

*   **Nombre d'Utilisateurs Concurrents visés :** Pics de 50 utilisateurs.
*   **Taille Moyenne des Livres :** 300 pages.
*   **Activité par Session Utilisateur :** 5 pages modifiées/produites par session.

## 4. Points à Approfondir et Défis Techniques

*   **Gestion des Diffs :** Mettre en place une logique backend (potentiellement dans le CLI Rust) pour calculer et présenter les différences entre deux versions de document, afin d'offrir une expérience utilisateur similaire à un "git diff" mais sans la complexité sous-jacente.
*   **Coûts Scaleway S3 :** Évaluer l'impact financier du stockage objet et des requêtes (PUT/GET) pour un volume de 50 utilisateurs x 300 pages x N versions. Optimisation de la fréquence des sauvegardes automatiques.
*   **Latence de Sauvegarde :** S'assurer que le processus de sauvegarde vers S3 et de mise à jour de PostgreSQL n'introduit pas une latence perceptible qui dégraderait l'expérience de l'écrivain. Optimisation des I/O.
*   **Orchestration CLI/MCP :** Définir précisément comment le front-end et le backend vont interagir avec le CLI Rust (pour la sauvegarde/lecture) et le MCP Rust (pour les appels IA). Gestion des files d'attente pour les requêtes IA.
*   **Permissions S3 :** Mettre en place une politique de sécurité robuste sur Scaleway S3 pour s'assurer que les utilisateurs n'accèdent qu'à leurs propres documents.
*   **Fonctionnalités Éditeur :** Quelles fonctionnalités spécifiques (mise en forme, chapitrage, commentaires) seront supportées par l'éditeur de texte pour s'intégrer efficacement avec le système de versioning et l'IA.

## 5. Briques Techniques Backend et IA (Propositions)

*   **Framework Web Rust (API) :** Actix-web ou Axum (choix recommandé pour performance et sécurité).
*   **ORM Rust pour PostgreSQL :** Diesel (pour une interaction BDD type-safe et efficace).
*   **Système de File d'Attente (pour tâches IA) :** Redis (pour gestion asynchrone des requêtes IA et fluidité UX).
*   **Client S3 Rust :** `rusoto_s3` ou `aws-sdk-rust` (pour l'intégration avec Scaleway S3).
*   **Orchestration IA :** Le MCP Rust (Message Control Protocol) sera le cœur de l'interaction avec Claude/Gemini.

## 6. Plan d'Implémentation V1 (Phasé)

### Phase 1 : Fondations Robustes (Le "Core Gameplay")

1.  **Mise en place de l'API Backend Rust :**
    *   Choisir et configurer Actix-web/Axum.
    *   Définir les endpoints de base (authentification, création/lecture/sauvegarde de document).
2.  **Intégration PostgreSQL et Authentification :**
    *   Mettre en place la base de données PostgreSQL.
    *   Utiliser Diesel pour gérer les utilisateurs et leurs sessions.
    *   Implémenter un système d'authentification robuste (JWT par exemple).
3.  **Gestion du Stockage S3 :**
    *   Configurer le client S3 Rust pour Scaleway.
    *   Implémenter la logique de sauvegarde et récupération des documents (une version par objet S3, métadonnées en PG).

### Phase 2 : Le "Story Mode" (L'Éditeur et l'UX)

1.  **Développement du Front-end (Éditeur CKEditor) :**
    *   Intégrer CKEditor 5.
    *   Implémenter les fonctions d'édition de base, sauvegarde automatique/manuelle.
2.  **Affichage de l'Historique des Versions :**
    *   Développer l'interface utilisateur pour lister les versions d'un document (via métadonnées PG).
    *   Implémenter la fonction de restauration d'une ancienne version.
3.  **Gestion Basique des Diffs :**
    *   Afficher une comparaison simple entre deux versions de texte (peut être un simple "raw diff" au début, amélioré plus tard).

### Phase 3 : Le "AI Co-pilot" (L'IA et la Collaboration)

1.  **Intégration du MCP Rust et File d'Attente IA :**
    *   Connecter le MCP Rust au backend via des appels internes ou un système de message.
    *   Mettre en place Redis comme file d'attente pour les requêtes AI.
    *   Implémenter la logique du MCP pour envoyer les requêtes aux APIs Claude/Gemini et gérer les réponses.
2.  **Fonctionnalités IA Initiale :**
    *   Implémenter une fonctionnalité simple comme la "génération de suggestions" ou la "révision de style" via l'IA.
    *   Intégrer les résultats de l'IA dans l'éditeur (ex: commentaires, surlignages, suggestions d'insertion).
3.  **Gestion des Commentaires et Surlignage (CKEditor) :**
    *   Utiliser les plugins de CKEditor pour les commentaires et le surlignage, en les liant au système d'authentification utilisateur et de versioning.

## 7. Lien avec l'API Claude ou Gemini

Le cœur de l'interaction avec les APIs Claude ou Gemini sera géré par ton **MCP Rust (Message Control Protocol)**.

*   **Le Rôle du MCP :** Le MCP agira comme un "proxy intelligent" ou un "orchestrateur" pour toutes les requêtes IA.
*   **Workflow :**
    1.  Le front-end envoie une requête pour une tâche IA (ex: "générer une suite", "réviser ce paragraphe") à ton API Rust.
    2.  L'API place cette requête dans la **file d'attente Redis**.
    3.  Le **MCP Rust**, qui écoute la file d'attente, récupère la tâche.
    4.  Le MCP utilise les **clés API** fournies par l'utilisateur (ou des clés système si c'est un service inclus) pour appeler l'API de Claude ou Gemini. Pour cela, il utilisera un client HTTP Rust (comme `reqwest`) et construira les requêtes JSON selon la documentation de l'API du modèle.
    5.  Une fois la réponse de l'IA reçue, le MCP la traite (parse le JSON, formate la réponse).
    6.  Le MCP renvoie le résultat (via un "callback" à l'API, une autre file d'attente, ou en mettant à jour directement la BDD/S3 si c'est une tâche en arrière-plan). L'API pourra ensuite notifier le front-end.
*   **Gestion des Clés API :** Les clés API de Claude/Gemini devraient être stockées de manière sécurisée (par exemple, encryptées dans PostgreSQL liées à l'utilisateur, ou comme variables d'environnement pour des clés système). Le MCP accédera à ces clés au moment de faire l'appel.
*   **Gestion des Limites et Coûts :** Le MCP sera également responsable de la gestion des "rate limits" des APIs IA et potentiellement du suivi de l'utilisation pour la facturation aux utilisateurs.

Ce plan permet de découpler les appels IA de l'API principale, assurant ainsi la résilience et la scalabilité de l'ensemble du système, même face aux temps de réponse variables des modèles IA.
